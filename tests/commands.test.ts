import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactOptions, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// consolidator-trigger spawns a worker subprocess; the command handler's contract is only that
// it calls the trigger after lowering the threshold, so swap it for a spy.
vi.mock("../src/hooks/consolidator-trigger.js", () => ({
	evaluateConsolidatorTrigger: vi.fn(),
}));

import { registerCompactCommand } from "../src/commands/compact.js";
import { registerConsolidateCommand } from "../src/commands/consolidate.js";
import { registerStatusCommand } from "../src/commands/status.js";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { Runtime } from "../src/runtime.js";
import { assistantToolCallMessage, observation, observationsRecordedEntry, rawMessage, contextEditEntry, type TestEntry } from "./fixtures/session.js";

type Notification = { message: string; level?: "info" | "warning" | "error" };
type UIStub = {
	notify: (message: string, level?: "info" | "warning" | "error") => void;
	setStatus: () => void;
	setWidget: () => void;
	theme: { fg: (_color: string, text: string) => string };
};
type CtxStub = {
	hasUI: boolean;
	cwd: string;
	ui: UIStub;
	sessionManager: { getBranch: () => unknown[]; getEntries: () => unknown[]; getSessionId: () => string };
	getContextUsage?: () => { tokens: number | null } | undefined;
	compact?: (options?: CompactOptions) => void;
};
type CommandOpts = { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

function makePi(): { pi: ExtensionAPI; commands: Map<string, CommandOpts> } {
	const commands = new Map<string, CommandOpts>();
	const pi = {
		registerCommand: (name: string, options: CommandOpts) => {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

function makeCtx(overrides: Partial<CtxStub> = {}): { ctx: CtxStub; notifications: Notification[] } {
	const notifications: Notification[] = [];
	const base: CtxStub = {
		hasUI: true,
		cwd: "/proj",
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_color, text) => text },
		},
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => "sess-1",
		},
	};
	return { ctx: { ...base, ...overrides }, notifications };
}

function commandHandler(commands: Map<string, CommandOpts>, name: string): CommandOpts {
	const entry = commands.get(name);
	if (!entry) throw new Error(`command ${name} was not registered`);
	return entry;
}

describe("registerCompactCommand", () => {
	it("notifies and returns when om is disabled", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		registerCompactCommand(pi, runtime);
		const { ctx, notifications } = makeCtx();

		await commandHandler(commands, "om:compact").handler("", ctx as unknown as ExtensionCommandContext);

		expect(notifications).toEqual([{ message: "om is off (use /om on to enable)", level: "info" }]);
		expect(runtime.compactInFlight).toBe(false);
	});

	it("notifies and returns without compacting when one is already in flight", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.compactInFlight = true;
		registerCompactCommand(pi, runtime);
		let compacted = false;
		const { ctx, notifications } = makeCtx({ compact: () => (compacted = true) });

		await commandHandler(commands, "om:compact").handler("", ctx as unknown as ExtensionCommandContext);

		expect(notifications).toEqual([{ message: "om: compaction already in progress", level: "warning" }]);
		expect(compacted).toBe(false);
	});

	it("raises the in-flight guard, notifies, and clears it on completion", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		registerCompactCommand(pi, runtime);
		let options: CompactOptions | undefined;
		const { ctx, notifications } = makeCtx({ compact: (o) => (options = o) });

		await commandHandler(commands, "om:compact").handler("", ctx as unknown as ExtensionCommandContext);

		expect(runtime.compactInFlight).toBe(true);
		expect(notifications).toEqual([{ message: "om: compacting (waiting for in-flight observers)…", level: "info" }]);
		expect(options).toBeDefined();

		options!.onComplete?.({} as never);
		expect(runtime.compactInFlight).toBe(false);
		expect(notifications.at(-1)).toEqual({ message: "om: compaction complete", level: "info" });
	});

	it("clears the guard and surfaces a non-cancel error", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		registerCompactCommand(pi, runtime);
		let options: CompactOptions | undefined;
		const { ctx, notifications } = makeCtx({ compact: (o) => (options = o) });

		await commandHandler(commands, "om:compact").handler("", ctx as unknown as ExtensionCommandContext);
		options!.onError?.(new Error("boom"));

		expect(runtime.compactInFlight).toBe(false);
		expect(notifications.at(-1)).toEqual({ message: "om: boom", level: "error" });
	});

	it("treats a cancelled compaction as silent", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		registerCompactCommand(pi, runtime);
		let options: CompactOptions | undefined;
		const { ctx, notifications } = makeCtx({ compact: (o) => (options = o) });

		await commandHandler(commands, "om:compact").handler("", ctx as unknown as ExtensionCommandContext);
		const before = notifications.length;
		options!.onError?.(new Error("Compaction cancelled"));

		expect(runtime.compactInFlight).toBe(false);
		expect(notifications.length).toBe(before);
	});
});

describe("registerConsolidateCommand", () => {
	const body = "x".repeat(40);

	it("notifies and returns when om is disabled", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		registerConsolidateCommand(pi, runtime);
		const { ctx, notifications } = makeCtx();

		await commandHandler(commands, "om:consolidate").handler("", ctx as unknown as ExtensionCommandContext);

		expect(notifications).toEqual([{ message: "om is off (use /om on to enable)", level: "info" }]);
	});

	it("notifies and returns when a consolidation is already in flight", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.consolidatorInFlight = true;
		registerConsolidateCommand(pi, runtime);
		const { ctx, notifications } = makeCtx();

		await commandHandler(commands, "om:consolidate").handler("", ctx as unknown as ExtensionCommandContext);

		expect(notifications).toEqual([{ message: "om: consolidation already in progress", level: "warning" }]);
	});

	it("reports nothing to consolidate when the pool is at or under target", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.configLoaded = true;
		registerConsolidateCommand(pi, runtime);
		const { ctx, notifications } = makeCtx();

		await commandHandler(commands, "om:consolidate").handler("", ctx as unknown as ExtensionCommandContext);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].message).toContain("nothing to consolidate");
		expect(evaluateConsolidatorTrigger).not.toHaveBeenCalled();
	});

	it("lowers the threshold, fires the trigger, and restores the threshold afterwards", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.configLoaded = true;
		runtime.config.poolTargetTokens = 10;
		runtime.config.consolidateAtPoolTokens = 15_000;
		registerConsolidateCommand(pi, runtime);
		const branch: TestEntry[] = [
			rawMessage("s1", body),
			observationsRecordedEntry("om-1", {
				observations: [observation("2026-05-02T10:00:01"), observation("2026-05-02T10:00:02"), observation("2026-05-02T10:00:03")],
				coversUpToId: "s1",
			}),
		];
		const { ctx, notifications } = makeCtx({ sessionManager: { getBranch: () => branch, getEntries: () => [], getSessionId: () => "sess-1" } });

		await commandHandler(commands, "om:consolidate").handler("", ctx as unknown as ExtensionCommandContext);

		expect(evaluateConsolidatorTrigger).toHaveBeenCalledTimes(1);
		const [calledPi, calledRuntime, calledCtx] = vi.mocked(evaluateConsolidatorTrigger).mock.calls[0];
		expect(calledPi).toBe(pi);
		expect(calledRuntime).toBe(runtime);
		expect(calledCtx).toBe(ctx);
		expect(runtime.config.consolidateAtPoolTokens).toBe(15_000);
		expect(notifications).toHaveLength(0);
	});
});

describe("registerStatusCommand", () => {
	let root: string;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("returns silently without UI", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		registerStatusCommand(pi, runtime);
		const { ctx, notifications } = makeCtx({ hasUI: false });

		await commandHandler(commands, "om:status").handler("", ctx as unknown as ExtensionCommandContext);

		expect(notifications).toHaveLength(0);
	});

	it("notifies when om is disabled", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		registerStatusCommand(pi, runtime);
		const { ctx, notifications } = makeCtx();

		await commandHandler(commands, "om:status").handler("", ctx as unknown as ExtensionCommandContext);

		expect(notifications).toEqual([{ message: "om is off (use /om on to enable)", level: "info" }]);
	});

	it("renders the status block from config, topics, journey, cost and a null context usage", async () => {
		root = mkdtempSync(join(tmpdir(), "om-status-"));
		const memoryRoot = join(root, ".memory", "sess-1");
		mkdirSync(memoryRoot, { recursive: true });
		writeFileSync(join(memoryRoot, "auth.md"), "---\nid: auth\ntitle: Auth\nsummary: a\n---\nbody");
		writeFileSync(join(memoryRoot, "JOURNEY.md"), "Started the project.");

		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.configLoaded = true;
		runtime.memoryRoot = memoryRoot;
		runtime.lastCompactionObserverWait = "waited";
		runtime.lastWorkerError = "worker blew up";
		registerStatusCommand(pi, runtime);
		const { ctx, notifications } = makeCtx({ getContextUsage: () => undefined });

		await commandHandler(commands, "om:status").handler("", ctx as unknown as ExtensionCommandContext);

		expect(notifications).toHaveLength(1);
		const report = notifications[0].message;
		expect(report).toContain("om status");
		expect(report).toContain("topic files: 1");
		expect(report).toContain("journey: ~");
		expect(report).toContain("context: ? /");
		expect(report).toContain("last compaction wait: waited");
		expect(report).toContain("last error: worker blew up");
		expect(report).toContain("session cost: $0.0000 (0 runs)");
	});

	it("reports only OM-appended evictions, never pi's own recovery omissions", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.configLoaded = true;
		// Two spans OM itself flushed this process: 3 + 2 entries, ~10k + ~1k tokens.
		runtime.evictionRecords.push(
			{ entryIds: ["u1", "a1", "r1"], tokens: 10_000 },
			{ entryIds: ["u2", "r2"], tokens: 1_000 },
		);
		registerStatusCommand(pi, runtime);
		// A branch carrying a context_edit omission OM never appended (pi's recovery path shape:
		// _omitRecoveryAttempt targets an assistant message) must contribute NOTHING to the tally.
		const branch = [
			rawMessage("u9", "x".repeat(40000)),
			assistantToolCallMessage("a9"),
			contextEditEntry("ce-recovery", { targetId: "a9", replacement: null }),
		];
		const { ctx, notifications } = makeCtx({
			sessionManager: {
				getBranch: () => branch,
				getEntries: () => [],
				getSessionId: () => "sess-1",
			},
		});

		await commandHandler(commands, "om:status").handler("", ctx as unknown as ExtensionCommandContext);

		const report = notifications[0].message;
		expect(report).toContain("evictions: 5 entries omitted");
		expect(report).toContain("~11,000 tok projected-context freed");
	});

	it("resets the eviction tally when nothing was recorded (e.g. right after a resume)", async () => {
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.configLoaded = true;
		registerStatusCommand(pi, runtime);
		// Even with omissions ON the branch (pre-resume OM work or pi recovery edits), the
		// in-process record is empty — the tally must show zeros, not borrowed credit.
		const branch = [
			rawMessage("u1", "x".repeat(40000)),
			contextEditEntry("ce1", { targetId: "u1", replacement: null }),
		];
		const { ctx, notifications } = makeCtx({
			sessionManager: {
				getBranch: () => branch,
				getEntries: () => [],
				getSessionId: () => "sess-1",
			},
		});

		await commandHandler(commands, "om:status").handler("", ctx as unknown as ExtensionCommandContext);

		const report = notifications[0].message;
		expect(report).toContain("evictions: 0 entries omitted (~0 tok projected-context freed)");
	});

	it("falls back to the 'none yet' journey and n/a wait, and reports a live context usage", async () => {
		root = mkdtempSync(join(tmpdir(), "om-status-"));
		const { pi, commands } = makePi();
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.configLoaded = true;
		runtime.memoryRoot = join(root, ".memory", "missing");
		registerStatusCommand(pi, runtime);
		const { ctx, notifications } = makeCtx({ getContextUsage: () => ({ tokens: 1234 }) });

		await commandHandler(commands, "om:status").handler("", ctx as unknown as ExtensionCommandContext);

		const report = notifications[0].message;
		expect(report).toContain("journey: none yet");
		expect(report).toContain("last compaction wait: n/a");
		expect(report).toContain("last error: none");
		expect(report).toContain("context: 1,234 /");
	});
});
