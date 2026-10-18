import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { Runtime } from "../src/runtime.js";
import { observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

// 40 chars ⇒ ~10 estimated tokens per source message.
const body = "x".repeat(40);

type Notification = { message: string; level?: "info" | "warning" | "error" };
type CtxStub = {
	hasUI: boolean;
	cwd: string;
	ui: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager?: { getBranch: () => unknown[] };
};
type HookHandler = (event: SessionBeforeCompactEvent, ctx: CtxStub) => Promise<unknown>;

function branchFixture(): TestEntry[] {
	return [
		rawMessage("raw-1", body),
		rawMessage("raw-2", body),
		observationsRecordedEntry("om-1", {
			observations: [observation("2026-05-02T10:00:01", { content: "early" })],
			coversUpToId: "raw-2",
		}),
		rawMessage("raw-3", body),
		rawMessage("raw-4", body),
		observationsRecordedEntry("om-2", {
			observations: [observation("2026-05-02T10:05:00", { content: "late" })],
			coversUpToId: "raw-4",
		}),
		rawMessage("raw-5", body),
		rawMessage("raw-6", body),
	];
}

function event(branch: TestEntry[]): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: { firstKeptEntryId: "raw-6", tokensBefore: 100 },
		branchEntries: branch,
	} as unknown as SessionBeforeCompactEvent;
}

type Harness = {
	handler: HookHandler;
	notifications: Notification[];
	ctx: CtxStub;
	runtime: Runtime;
};

function makeHarness(opts: { branch?: TestEntry[]; withSessionManager?: boolean } = {}): Harness {
	const branch = opts.branch ?? branchFixture();
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.enabled = true;

	const notifications: Notification[] = [];
	const ctx: CtxStub = {
		hasUI: true,
		cwd: "/proj",
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	};
	if (opts.withSessionManager !== false) ctx.sessionManager = { getBranch: () => branch };

	let registered: HookHandler | undefined;
	const pi = {
		on: (name: string, handler: HookHandler) => {
			if (name === "session_before_compact") registered = handler;
		},
	} as unknown as ExtensionAPI;

	registerCompactionHook(pi, runtime);
	if (!registered) throw new Error("session_before_compact handler was not registered");
	return { handler: registered, notifications, ctx, runtime };
}

describe("registerCompactionHook", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "om-hook-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns undefined while om is disabled", async () => {
		const harness = makeHarness();
		harness.runtime.enabled = false;
		expect(await harness.handler(event(branchFixture()), harness.ctx)).toBeUndefined();
	});

	it("returns undefined in passive mode", async () => {
		const harness = makeHarness();
		harness.runtime.config.passive = true;
		expect(await harness.handler(event(branchFixture()), harness.ctx)).toBeUndefined();
	});

	it("cancels a duplicate compaction without touching the guard", async () => {
		const harness = makeHarness();
		harness.runtime.memoryRoot = join(root, ".memory", "sess-1");
		harness.runtime.compactHookInFlight = true;

		const result = await harness.handler(event(branchFixture()), harness.ctx);

		expect(result).toEqual({ cancel: true });
		expect(harness.runtime.compactHookInFlight).toBe(true);
		expect(harness.notifications).toEqual([
			{ message: "om: another compaction is already in progress; cancelling duplicate", level: "warning" },
		]);
	});

	it("skips the observer wait and renders the block from settled state", async () => {
		const harness = makeHarness();
		harness.runtime.memoryRoot = join(root, ".memory", "sess-1");
		harness.runtime.config.tailTokens = 20; // snapped tail is exactly 20 ⇒ stable ⇒ skip

		const result = (await harness.handler(event(branchFixture()), harness.ctx)) as {
			compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number };
		};

		expect(harness.runtime.lastCompactionObserverWait).toBe("skipped");
		expect(harness.runtime.compactHookInFlight).toBe(false);
		expect(harness.notifications).toHaveLength(0);
		expect(result.compaction.firstKeptEntryId).toBe("raw-5");
		expect(result.compaction.tokensBefore).toBe(100);
		expect(result.compaction.summary).toContain("early");
		expect(result.compaction.summary).toContain("late");
	});

	it("waits for observers, recomputes the snap, then renders", async () => {
		const harness = makeHarness();
		harness.runtime.memoryRoot = join(root, ".memory", "sess-1");
		harness.runtime.config.tailTokens = 5; // snapped tail 20 > 5 ⇒ not stable ⇒ wait

		const result = await harness.handler(event(branchFixture()), harness.ctx);

		expect(harness.runtime.lastCompactionObserverWait).toBe("waited");
		expect(harness.notifications).toEqual([
			{ message: "om: waiting for in-flight observers before folding…", level: "info" },
		]);
		expect(result).toBeDefined();
	});

	it("falls back to the event's branchEntries when the context exposes no session manager", async () => {
		const branch = branchFixture();
		const harness = makeHarness({ branch, withSessionManager: false });
		harness.runtime.memoryRoot = join(root, ".memory", "sess-1");
		harness.runtime.config.tailTokens = 20;

		const result = (await harness.handler(event(branch), harness.ctx)) as {
			compaction: { firstKeptEntryId: string };
		};

		expect(result.compaction.firstKeptEntryId).toBe("raw-5");
	});
});
