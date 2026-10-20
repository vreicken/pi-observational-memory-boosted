import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompactOptions, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import observationalMemory from "../src/index.js";
import { OM_ENABLED } from "../src/ledger/index.js";
import { unknownCustomEntry, type TestEntry } from "./fixtures/session.js";

type Notification = { message: string; level?: "info" | "warning" | "error" };
type UIStub = {
	notify: (message: string, level?: "info" | "warning" | "error") => void;
	setStatus: (key: string, text: string | undefined) => void;
	setWidget: (key: string, content: string[] | undefined) => void;
	theme: { fg: (_color: string, text: string) => string };
};
/**
 * pi's `ExtensionMode` (dist/core/extensions/types.d.ts) — not re-exported from the package root,
 * so the union is declared here. `mode` itself is required on a real `ExtensionContext`; the stub
 * keeps it optional so a case can model an absent field, but every host-shaped case uses a real
 * mode string.
 */
type HostMode = "tui" | "rpc" | "json" | "print";
type CtxStub = {
	hasUI: boolean;
	cwd: string;
	mode?: HostMode;
	ui: UIStub;
	sessionManager: {
		getBranch: () => unknown[];
		getEntries: () => unknown[];
		getSessionId: () => string;
		getHeader?: () => { parentSession?: string } | null;
	};
	getContextUsage?: () => { tokens: number | null } | undefined;
	compact?: (options?: CompactOptions) => void;
};
type EventHandler = (event: unknown, ctx: CtxStub) => unknown;
type CommandOpts = { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

type Harness = {
	handlers: Map<string, EventHandler[]>;
	commands: Map<string, CommandOpts>;
	appended: Array<{ customType: string; data: unknown }>;
	notifications: Notification[];
	statusText: Array<string | undefined>;
	widgets: Array<string[] | undefined>;
	ctx: CtxStub;
};

function gateEntry(id: string, enabled: boolean): TestEntry {
	return unknownCustomEntry(id, OM_ENABLED, { enabled });
}

function handlerFor(harness: Harness, event: string): EventHandler {
	const list = harness.handlers.get(event);
	if (!list || list.length === 0) throw new Error(`no handler registered for ${event}`);
	return list[0];
}

function makeHarness(cwd: string, opts: { hasUI?: boolean; mode?: HostMode; branch?: TestEntry[] } = {}): Harness {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, CommandOpts>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: Notification[] = [];
	const statusText: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];

	const pi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, options: CommandOpts) => commands.set(name, options),
		appendEntry: (customType: string, data?: unknown) => appended.push({ customType, data }),
		sendMessage: () => {},
	} as unknown as ExtensionAPI;

	const ctx: CtxStub = {
		hasUI: opts.hasUI ?? true,
		cwd,
		mode: opts.mode,
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: (_key, text) => statusText.push(text),
			setWidget: (_key, content) => widgets.push(content),
			theme: { fg: (_color, text) => text },
		},
		sessionManager: {
			getBranch: () => opts.branch ?? [],
			getEntries: () => [],
			getSessionId: () => "sess-1",
			getHeader: () => null,
		},
		getContextUsage: () => undefined,
	};

	observationalMemory(pi);
	return { handlers, commands, appended, notifications, statusText, widgets, ctx };
}

async function invokeCommand(harness: Harness, name: string, args: string): Promise<void> {
	const command = harness.commands.get(name);
	if (!command) throw new Error(`command ${name} was not registered`);
	await command.handler(args, harness.ctx as unknown as ExtensionCommandContext);
}

async function invokeEvent(harness: Harness, event: string): Promise<void> {
	await handlerFor(harness, event)({ type: event }, harness.ctx);
}

describe("observationalMemory wiring", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-index-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("registers every command and event handler exactly once", () => {
		const harness = makeHarness(cwd);
		expect([...harness.commands.keys()].sort()).toEqual(["om", "om:compact", "om:consolidate", "om:status"]);
		expect(harness.handlers.get("session_start")).toHaveLength(1);
		expect(harness.handlers.get("session_shutdown")).toHaveLength(1);
		// observer trigger + consolidation trigger + eviction flush + compaction trigger all ride turn_end.
		expect(harness.handlers.get("turn_end")).toHaveLength(4);
		expect(harness.handlers.get("agent_start")).toHaveLength(2);
		expect(harness.handlers.get("agent_before_settle")).toHaveLength(1);
		expect(harness.handlers.get("session_before_compact")).toHaveLength(1);
	});

	it("stays invisible with no gate entry: session_start leaves it off, /om off is a no-op", async () => {
		const harness = makeHarness(cwd);
		await invokeEvent(harness, "session_start");

		expect(harness.statusText).toHaveLength(0);
		await invokeCommand(harness, "om", "off");
		expect(harness.notifications).toEqual([{ message: "om already off", level: "info" }]);
		expect(harness.appended).toHaveLength(0);
	});

	it("reads the newest gate entry, so a later 'off' overrides an earlier 'on'", async () => {
		const harness = makeHarness(cwd, { branch: [gateEntry("g1", true), gateEntry("g2", false)] });
		await invokeEvent(harness, "session_start");

		await invokeCommand(harness, "om", "off");
		expect(harness.notifications).toEqual([{ message: "om already off", level: "info" }]);
	});

	it("enables, attaches and seeds memory when the gate entry says on", async () => {
		const harness = makeHarness(cwd, { branch: [gateEntry("g1", true)], mode: "tui" });
		await invokeEvent(harness, "session_start");

		// attach() sets the footer at session_start.
		expect(harness.statusText).toContain("om");

		await invokeCommand(harness, "om", "off");
		expect(harness.appended).toEqual([{ customType: OM_ENABLED, data: { enabled: false } }]);
		expect(harness.notifications).toEqual([{ message: "om disabled", level: "info" }]);
		// detach() clears footer + widget.
		expect(harness.statusText).toContain(undefined);
		expect(harness.widgets).toContain(undefined);
	});

	// The guard is `mode === "tui"`, NOT `hasUI`: pi reports hasUI true in rpc mode too, and rpc's
	// setStatus/setWidget emit real extension_ui_request frames, so an hasUI-swap would ship the
	// footer/widget to a headless RPC host. Each real non-tui mode is pinned here so that swap
	// (the originally proposed fix) fails loudly instead of silently widening the footprint.
	it.each<HostMode>(["rpc", "json", "print"])("does not touch the UI in %s mode even with hasUI true", async (mode) => {
		const harness = makeHarness(cwd, { branch: [gateEntry("g1", true)], mode, hasUI: true });
		await invokeEvent(harness, "session_start");

		expect(harness.statusText).toHaveLength(0);
		expect(harness.widgets).toHaveLength(0);
	});

	it("does not attach in tui mode when the host reports no dialog-capable UI", async () => {
		const harness = makeHarness(cwd, { branch: [gateEntry("g1", true)], mode: "tui", hasUI: false });
		await invokeEvent(harness, "session_start");

		expect(harness.statusText).toHaveLength(0);
	});

	it("enables the gate with /om on in rpc mode but still leaves the host UI untouched", async () => {
		const harness = makeHarness(cwd, { mode: "rpc", hasUI: true });
		await invokeEvent(harness, "session_start");

		await invokeCommand(harness, "om", "on");
		expect(harness.appended).toEqual([{ customType: OM_ENABLED, data: { enabled: true } }]);
		expect(harness.statusText).toHaveLength(0);
		expect(harness.widgets).toHaveLength(0);
	});

	it("toggles on with /om on, refuses a redundant on, then toggles off with a bare /om", async () => {
		const harness = makeHarness(cwd, { mode: "tui" });
		await invokeEvent(harness, "session_start");

		await invokeCommand(harness, "om", "on");
		expect(harness.appended).toEqual([{ customType: OM_ENABLED, data: { enabled: true } }]);
		expect(harness.notifications.at(-1)).toEqual({ message: "om enabled", level: "info" });

		await invokeCommand(harness, "om", "on");
		expect(harness.notifications.at(-1)).toEqual({ message: "om already on", level: "info" });

		await invokeCommand(harness, "om", "");
		expect(harness.notifications.at(-1)).toEqual({ message: "om disabled", level: "info" });
		expect(harness.appended).toHaveLength(2);
	});

	it("does not attach when the host is not in tui mode even with the gate on", async () => {
		const harness = makeHarness(cwd, { branch: [gateEntry("g1", true)], mode: undefined });
		await invokeEvent(harness, "session_start");

		expect(harness.statusText).toHaveLength(0);
	});

	it("aborts workers and detaches on session_shutdown", async () => {
		const harness = makeHarness(cwd, { branch: [gateEntry("g1", true)], mode: "tui" });
		await invokeEvent(harness, "session_start");
		await invokeEvent(harness, "session_shutdown");

		expect(harness.statusText).toContain(undefined);
	});
});
