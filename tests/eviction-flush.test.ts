import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	SessionBoundaryDraft,
	TurnEndEvent,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";

// The observer commit path spawns subprocesses; the wiring under test here is only that a
// COMMIT (>=1 observation) enqueues eviction candidates from the exact slice. Swap the spawn
// and IPC modules for stubs so no real worker runs.
vi.mock("../src/spawn/launch.js", () => ({
	spawnWorker: vi.fn(),
	buildWorkerArgv: vi.fn(() => []),
	buildWorkerEnv: vi.fn(() => ({})),
}));
vi.mock("../src/spawn/runs.js", () => ({
	readObserverResult: vi.fn(),
	readWorkerCost: vi.fn(),
	runCostPath: vi.fn(() => "cost"),
	runResultPath: vi.fn(() => "result"),
}));

import { spawnWorker } from "../src/spawn/launch.js";
import { readObserverResult, readWorkerCost } from "../src/spawn/runs.js";
import { evaluateObserverTriggers } from "../src/hooks/observer-trigger.js";
import { registerEvictionFlush } from "../src/hooks/eviction-flush.js";
import { Runtime } from "../src/runtime.js";
import {
	assistantToolCallMessage,
	rawMessage,
	toolResultMessage,
	observationsRecordedEntry,
	observation,
	type TestEntry,
} from "./fixtures/session.js";

const GIANT = "x".repeat(40_000); // ~10k tokens — above evictionMinTokens (5000)

type Notification = { message: string; level?: "info" | "warning" | "error" };
type CtxStub = {
	hasUI: boolean;
	cwd: string;
	ui: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => unknown[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
};
type BoundaryHandler = (
	event: TurnEndEvent,
	ctx: CtxStub,
) => TurnEndEventResult | void;

function observedBranch(): TestEntry[] {
	return [
		rawMessage("u1", "find the biggest file"),
		assistantToolCallMessage("a1", { toolName: "bash" }),
		toolResultMessage("r1", GIANT),
		rawMessage("u2", "next turn"),
	];
}

function turnEvent(overrides: { entries?: SessionBoundaryDraft[] } = {}): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: { role: "user", content: "hi" },
		toolResults: [],
		entries: overrides.entries ?? [],
		continue: false,
	} as unknown as TurnEndEvent;
}

describe("registerEvictionFlush", () => {
	const createdTempRoots: string[] = [];
	afterEach(() => {
		for (const root of createdTempRoots) rmSync(root, { recursive: true, force: true });
		createdTempRoots.length = 0;
		vi.clearAllMocks();
	});

	function makeHarness(opts: {
		enabled?: boolean;
		passive?: boolean;
		flagOn?: boolean;
		branch?: TestEntry[];
		liveTokens?: number | null | undefined;
		compactAtContextTokens?: number;
	}): { runtime: Runtime; turn: BoundaryHandler[]; settle: BoundaryHandler[]; notifications: Notification[]; ctx: CtxStub } {
		const runtime = new Runtime();
		runtime.enabled = opts.enabled ?? true;
		runtime.configLoaded = true;
		runtime.config.passive = opts.passive ?? false;
		runtime.config.evictObservedEntries = opts.flagOn ?? true;
		if (opts.compactAtContextTokens !== undefined) runtime.config.compactAtContextTokens = opts.compactAtContextTokens;
		createdTempRoots.push(mkdtempSync(join(tmpdir(), "om-eviction-")));
		runtime.memoryRoot = join(createdTempRoots.at(-1)!, ".memory", "sess-1");

		const turn: BoundaryHandler[] = [];
		const settle: BoundaryHandler[] = [];
		const pi = {
			on: (event: string, handler: BoundaryHandler) => {
				if (event === "turn_end") turn.push(handler);
				if (event === "agent_before_settle") settle.push(handler);
			},
		} as unknown as ExtensionAPI;

		registerEvictionFlush(pi, runtime);

		const notifications: Notification[] = [];
		const ctx: CtxStub = {
			hasUI: true,
			cwd: "/proj",
			ui: { notify: (message, level) => notifications.push({ message, level }) },
			sessionManager: { getBranch: () => opts.branch ?? [] },
			getContextUsage: () => (opts.liveTokens === undefined ? undefined : { tokens: opts.liveTokens ?? null }),
		};
		if (turn.length === 0 || settle.length === 0) throw new Error("eviction handlers were not registered");
		return { runtime, turn, settle, notifications, ctx };
	}

	it("does nothing while om is disabled", () => {
		const { runtime, turn, ctx } = makeHarness({ enabled: false });
		runtime.pendingEvictions.push({ entryIds: ["u1", "a1", "r1"], tokens: 9000 });
		expect(turn[0](turnEvent(), ctx)).toBeUndefined();
	});

	it("does nothing in passive mode", () => {
		const { runtime, turn, ctx } = makeHarness({ passive: true });
		runtime.pendingEvictions.push({ entryIds: ["u1", "a1", "r1"], tokens: 9000 });
		expect(turn[0](turnEvent(), ctx)).toBeUndefined();
	});

	it("does nothing with the config flag off (default)", () => {
		const { runtime, turn, ctx } = makeHarness({ flagOn: false });
		runtime.pendingEvictions.push({ entryIds: ["u1", "a1", "r1"], tokens: 9000 });
		expect(turn[0](turnEvent(), ctx)).toBeUndefined();
	});

	it("does nothing when no committed slice left candidates", () => {
		const { turn, ctx } = makeHarness({ branch: observedBranch() });
		expect(turn[0](turnEvent(), ctx)).toBeUndefined();
	});

	it("returns no drafts while projected context is inside the compaction-imminence window", () => {
		const { runtime, turn, ctx } = makeHarness({ branch: observedBranch(), compactAtContextTokens: 12_000 });
		runtime.pendingEvictions.push({ entryIds: ["u1", "a1", "r1"], tokens: 9000 });
		expect(turn[0](turnEvent(), ctx)).toBeUndefined();
		expect(runtime.pendingEvictions).toHaveLength(0);
	});

	it("chains context_edit omission drafts after the accumulated boundary entries on turn_end", async () => {
		const branch = observedBranch();
		const { runtime, turn, notifications, ctx } = makeHarness({ branch });
		runtime.pendingEvictions.push({ entryIds: ["u1", "a1", "r1"], tokens: 9000 });

		const foreign: SessionBoundaryDraft = { type: "custom", customType: "other.ext", data: {} };
		const result = turn[0](turnEvent({ entries: [foreign] }), ctx);

		const entries = result?.entries ?? [];
		expect(entries[0]).toBe(foreign);
		expect(entries.slice(1)).toEqual([
			{ type: "context_edit", targetId: "u1", replacement: null },
			{ type: "context_edit", targetId: "a1", replacement: null },
			{ type: "context_edit", targetId: "r1", replacement: null },
		]);
		// Omission is metadata-only: no continuation is requested.
		expect(result?.continue).toBeUndefined();
		// Toasts go through the coalescer — one tick for the batched notify.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(notifications.some((note) => note.message.includes("evicted 3 entries"))).toBe(true);
	});

	it("flushes the same candidates on agent_before_settle (catch-flush for settled runs)", () => {
		const branch = observedBranch();
		const { runtime, settle, ctx } = makeHarness({ branch });
		runtime.pendingEvictions.push({ entryIds: ["u1", "a1", "r1"], tokens: 9000 });

		const result = settle[0](turnEvent(), ctx);
		const entries = result?.entries ?? [];
		expect(entries.map((entry) => (entry as { targetId?: string }).targetId)).toEqual(["u1", "a1", "r1"]);
	});

	it("drains the pending candidates on flush so nothing re-fires", () => {
		const branch = observedBranch();
		const { runtime, turn, ctx } = makeHarness({ branch });
		runtime.pendingEvictions.push({ entryIds: ["u1", "a1", "r1"], tokens: 9000 });
		expect(turn[0](turnEvent(), ctx)).toBeDefined();
		expect(runtime.pendingEvictions).toHaveLength(0);
		expect(turn[0](turnEvent(), ctx)).toBeUndefined();
	});

	it("skips spans whose targets became stale since the commit (no Invalid boundary entries fallout)", () => {
		const { runtime, turn, ctx, notifications } = makeHarness({ branch: observedBranch() });
		runtime.pendingEvictions.push({
			entryIds: ["ghost-1", "ghost-2"], // ids not on the active branch (tree stray)
			tokens: 9000,
		});
		expect(turn[0](turnEvent(), ctx)).toBeUndefined();
		// No notify either: nothing was evicted.
		expect(notifications).toHaveLength(0);
	});

	it("degrades conservatively to a no-op after resume: no eviction from ledger coverage alone", () => {
		// A fresh Runtime (the resume shape) with an empty pendingEvictions list, against a
		// branch whose ledger already holds committed coverage. The pre-resume slice rides
		// verbatim — decisions are never inferred from bare ledger watermarks.
		const branch = observedBranch();
		branch.push(observationsRecordedEntry("rec-1", { observations: [observation("2026-05-02T10:00:00")], coversUpToId: "r1" }));
		const { runtime, turn, ctx } = makeHarness({ branch });
		expect(runtime.pendingEvictions).toHaveLength(0);
		expect(turn[0](turnEvent(), ctx)).toBeUndefined();
	});

it("composes with a compaction draft in the same boundary, keeping the chained order", () => {
		// With a LIVE threshold-triggered compaction the flush declines by the imminence guard
		// (the threshold sits inside the imminence window — co-firing is impossible by design),
		// so the same-boundary composition to verify is the chained accumulation: a compaction
		// draft from another handler/extension arrives in the set, and the flusher chains AFTER
		// it without disturbing anything.
		const branch = observedBranch();
		const { runtime, turn, ctx } = makeHarness({ branch });
		runtime.pendingEvictions.push({ entryIds: ["u1", "a1", "r1"], tokens: 9000 });

		const compactionDraft: SessionBoundaryDraft = {
			type: "compaction",
			summary: "already prepared",
			firstKeptEntryId: "u4",
		};
		const result = turn[0](turnEvent({ entries: [compactionDraft] }), ctx);

		expect(result?.entries).toHaveLength(4);
		expect(result?.entries?.[0]).toBe(compactionDraft);
		expect(result?.entries?.slice(1).every((entry) => (entry as { type: string }).type === "context_edit")).toBe(true);
		// Omission drafts never touch the continuation decision.
		expect(result?.continue).toBeUndefined();
	});
});


describe("observer commit selects eviction candidates from the exact committed slice", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function makeObserverEnv(opts: { flagOn?: boolean } = {}) {
		const runtime = new Runtime();
		runtime.enabled = true;
		runtime.configLoaded = true;
		runtime.config.passive = false;
		runtime.config.evictObservedEntries = opts.flagOn ?? true;
		runtime.config.chunkTokens = 10_000;

		const branch = observedBranch();
		const appended: Array<{ customType: string; data: unknown }> = [];
		const pi = {
			on: () => {},
			appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		} as unknown as ExtensionAPI;

		const ctx = {
			hasUI: true,
			ui: { notify: () => {} },
			sessionManager: { getBranch: () => branch, getEntries: () => [] },
			getContextUsage: () => undefined,
		};

		return { runtime, pi, ctx, appended };
	}

	async function dispatchAndWait(env: ReturnType<typeof makeObserverEnv>): Promise<ReturnType<typeof makeObserverEnv>> {
		evaluateObserverTriggers(env.pi, env.runtime, env.ctx as never);
		await env.runtime.whenObserversIdle();
		return env;
	}

	it("enqueues an oversized wholly-covered span after a commit with >=1 observation", async () => {
		vi.mocked(spawnWorker).mockResolvedValue({ code: 0, signal: null, stderr: "" });
		vi.mocked(readObserverResult).mockReturnValue({ observations: [{ timestamp: "2026-05-02 10:00", content: "saw the file" }] });
		vi.mocked(readWorkerCost).mockReturnValue(undefined);

		const { runtime, appended } = await dispatchAndWait(makeObserverEnv());

		expect(appended).toHaveLength(1);
		expect(appended[0].customType).toBe("om.observations.recorded");
		expect(runtime.pendingEvictions).toHaveLength(1);
		// The candidate spans exactly what the committed slice observed and was terminated by.
		expect(runtime.pendingEvictions[0].entryIds).toEqual(["u1", "a1", "r1"]);
		expect(runtime.pendingEvictions[0].tokens).toBeGreaterThan(5000);
	});

	it("enqueues nothing when the observer failed (no commit, no coverage)", async () => {
		vi.mocked(spawnWorker).mockResolvedValue({ code: 1, signal: null, stderr: "boom" });
		vi.mocked(readWorkerCost).mockReturnValue(undefined);

		const { runtime, appended } = await dispatchAndWait(makeObserverEnv());

		expect(appended).toHaveLength(0);
		expect(runtime.pendingEvictions).toHaveLength(0);
	});

	it("enqueues nothing for a zero-observation chunk (it commits no record)", async () => {
		vi.mocked(spawnWorker).mockResolvedValue({ code: 0, signal: null, stderr: "" });
		vi.mocked(readObserverResult).mockReturnValue({ observations: [] });
		vi.mocked(readWorkerCost).mockReturnValue(undefined);

		const { runtime, appended } = await dispatchAndWait(makeObserverEnv());

		expect(appended).toHaveLength(0);
		expect(runtime.pendingEvictions).toHaveLength(0);
	});

	it("enqueues nothing while the eviction flag is off", async () => {
		vi.mocked(spawnWorker).mockResolvedValue({ code: 0, signal: null, stderr: "" });
		vi.mocked(readObserverResult).mockReturnValue({ observations: [{ timestamp: "2026-05-02 10:00", content: "saw the file" }] });
		vi.mocked(readWorkerCost).mockReturnValue(undefined);

		const { runtime, appended } = await dispatchAndWait(makeObserverEnv({ flagOn: false }));

		// The observation still commits; only eviction selection is skipped.
		expect(appended).toHaveLength(1);
		expect(runtime.pendingEvictions).toHaveLength(0);
	});
});
