import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStartEvent, ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";

// The consolidator dispatch spawns a worker subprocess and reads its captured cost off disk;
// both are stubbed so what runs here is the trigger's own contract — guards, prompt/argv
// construction, the tombstone commit, and the error path. Same stubbing shape as the
// observer-side dispatch covered in eviction-flush.test.ts.
vi.mock("../src/spawn/launch.js", () => ({
	spawnWorker: vi.fn(),
	buildWorkerArgv: vi.fn(() => ["stub-argv"]),
	buildWorkerEnv: vi.fn(() => ({ OM_WORKER: "consolidator" })),
}));
vi.mock("../src/spawn/runs.js", () => ({
	readObserverResult: vi.fn(),
	readWorkerCost: vi.fn(),
	runCostPath: vi.fn(() => "cost-path"),
	runResultPath: vi.fn(() => "result-path"),
}));

import { buildWorkerArgv, buildWorkerEnv, spawnWorker } from "../src/spawn/launch.js";
import { readWorkerCost } from "../src/spawn/runs.js";
import { evaluateConsolidatorTrigger, registerConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { OM_COST, OM_OBSERVATIONS_DROPPED } from "../src/ledger/index.js";
import { Runtime } from "../src/runtime.js";
import {
	assistantToolCallMessage,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	rawMessage,
	unknownCustomEntry,
	type TestEntry,
	type TestObservation,
} from "./fixtures/session.js";

type Notification = { message: string; level?: "info" | "warning" | "error" };
type CtxStub = {
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => TestEntry[]; getEntries: () => TestEntry[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
};
type BoundaryHandler = (event: TurnEndEvent | AgentStartEvent, ctx: CtxStub) => void;

type Harness = {
	runtime: Runtime;
	pi: ExtensionAPI;
	ctx: CtxStub;
	notifications: Notification[];
	appended: Array<{ customType: string; data: unknown }>;
	turn: BoundaryHandler[];
	agentStart: BoundaryHandler[];
	memoryRoot: string;
};

const OLD_OBS = observation("2026-05-02T10:00:00", { content: "old observation", tokenCount: 10 });
const NEW_OBS = observation("2026-05-02T10:01:00", { content: "new observation", tokenCount: 10 });

/** A branch whose ledger holds the given active observations, with source entries for the anchor. */
function ledgerBranch(observations: TestObservation[], opts: { withSourceEntries?: boolean } = {}): TestEntry[] {
	const branch: TestEntry[] = [];
	if (opts.withSourceEntries ?? true) {
		branch.push(rawMessage("u1", "do the thing"));
		branch.push(assistantToolCallMessage("a1", { toolName: "bash" }));
	}
	branch.push(observationsRecordedEntry("om1", { observations, coversUpToId: "a1" }));
	return branch;
}

describe("consolidator trigger", () => {
	const tempRoots: string[] = [];

	afterEach(() => {
		for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
		tempRoots.length = 0;
		vi.clearAllMocks();
	});

	beforeEach(() => {
		// A cost file that does not exist is the default: no om.cost append.
		vi.mocked(readWorkerCost).mockReturnValue(undefined);
	});

	function makeHarness(
		opts: {
			enabled?: boolean;
			passive?: boolean;
			inFlight?: boolean;
			branch?: TestEntry[];
			hasUI?: boolean;
			withContextUsage?: boolean;
			consolidateAtPoolTokens?: number;
			poolTargetTokens?: number;
		} = {},
	): Harness {
		const runtime = new Runtime();
		runtime.enabled = opts.enabled ?? true;
		runtime.configLoaded = true;
		runtime.config.passive = opts.passive ?? false;
		runtime.config.consolidateAtPoolTokens = opts.consolidateAtPoolTokens ?? 20;
		runtime.config.poolTargetTokens = opts.poolTargetTokens ?? 10;
		runtime.consolidatorInFlight = opts.inFlight ?? false;

		const root = mkdtempSync(join(tmpdir(), "om-consolidator-"));
		tempRoots.push(root);
		runtime.memoryRoot = join(root, ".memory", "sess-1");

		const turn: BoundaryHandler[] = [];
		const agentStart: BoundaryHandler[] = [];
		const pi = {
			on: (event: string, handler: BoundaryHandler) => {
				if (event === "turn_end") turn.push(handler);
				if (event === "agent_start") agentStart.push(handler);
			},
			appendEntry: () => {},
		} as unknown as ExtensionAPI;

		const notifications: Notification[] = [];
		const branch = opts.branch ?? [];
		const ctx: CtxStub = {
			hasUI: opts.hasUI ?? true,
			ui: { notify: (message, level) => notifications.push({ message, level }) },
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
		};
		if (opts.withContextUsage ?? true) ctx.getContextUsage = () => ({ tokens: 1234 });

		return { runtime, pi, ctx, notifications, appended: [], turn, agentStart, memoryRoot: runtime.memoryRoot };
	}

	/** Attach the append-recording pi stub AFTER the harness exists, then register the trigger. */
	function register(harness: Harness): Harness {
		harness.pi = {
			on: (event: string, handler: BoundaryHandler) => {
				if (event === "turn_end") harness.turn.push(handler);
				if (event === "agent_start") harness.agentStart.push(handler);
			},
			appendEntry: (customType: string, data?: unknown) => harness.appended.push({ customType, data }),
		} as unknown as ExtensionAPI;
		registerConsolidatorTrigger(harness.pi, harness.runtime);
		return harness;
	}

	/** The dispatched run is fire-and-forget; wait for its observable commit before asserting. */
	async function settleDispatch(harness: Harness): Promise<void> {
		await vi.waitFor(() => {
			expect(harness.runtime.consolidatorInFlight).toBe(false);
		});
		// The finish toast is coalesced onto the next event-loop tick.
		await new Promise((resolve) => setTimeout(resolve, 5));
	}

	describe("registration", () => {
		it("binds one shared handler to both notification-only and actionable boundaries", () => {
			const harness = register(makeHarness());
			expect(harness.turn).toHaveLength(1);
			expect(harness.agentStart).toHaveLength(1);
			expect(harness.turn[0]).toBe(harness.agentStart[0]);
		});
	});

	describe("guards", () => {
		it("does nothing while om is disabled", () => {
			const harness = register(makeHarness({ enabled: false, branch: ledgerBranch([OLD_OBS, NEW_OBS]) }));
			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			expect(spawnWorker).not.toHaveBeenCalled();
			expect(harness.runtime.consolidatorInFlight).toBe(false);
		});

		it("does nothing in passive mode", () => {
			const harness = register(makeHarness({ passive: true, branch: ledgerBranch([OLD_OBS, NEW_OBS]) }));
			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			expect(spawnWorker).not.toHaveBeenCalled();
		});

		it("does not fire a second consolidator while one is in flight", () => {
			const harness = register(makeHarness({ inFlight: true, branch: ledgerBranch([OLD_OBS, NEW_OBS]) }));
			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			expect(spawnWorker).not.toHaveBeenCalled();
			expect(harness.runtime.consolidatorInFlight).toBe(true);
		});

		it("stays quiet while the active pool is below the consolidation threshold", () => {
			const harness = register(
				makeHarness({ branch: ledgerBranch([OLD_OBS, NEW_OBS]), consolidateAtPoolTokens: 30 }),
			);
			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			expect(spawnWorker).not.toHaveBeenCalled();
			expect(harness.notifications).toHaveLength(0);
		});

		it("stays quiet when everything in the pool fits under the promotion target", () => {
			const harness = register(
				makeHarness({ branch: ledgerBranch([OLD_OBS, NEW_OBS]), consolidateAtPoolTokens: 20, poolTargetTokens: 100 }),
			);
			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			expect(spawnWorker).not.toHaveBeenCalled();
		});
	});

	describe("dispatch", () => {
		it("promotes the overflow, tombstones exactly the promoted batch, and re-renders INDEX.md", async () => {
			const harness = register(makeHarness({ branch: ledgerBranch([OLD_OBS, NEW_OBS]) }));
			// A topic file on disk so the re-rendered INDEX has something to describe.
			mkdirSync(harness.memoryRoot, { recursive: true });
			writeFileSync(
				join(harness.memoryRoot, "auth.md"),
				"---\nid: auth\ntitle: Auth\nsummary: how login works\nupdated: 2026-05-02\n---\nbody\n",
			);
			let inFlightDuringSpawn = false;
			vi.mocked(spawnWorker).mockImplementation(() => {
				inFlightDuringSpawn = harness.runtime.consolidatorInFlight;
				return Promise.resolve({ code: 0, signal: null, stderr: "" });
			});

			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			expect(readWorkerCost).toBeDefined();
			await settleDispatch(harness);

			expect(inFlightDuringSpawn).toBe(true);
			expect(buildWorkerEnv).toHaveBeenCalledWith("consolidator", { memoryRoot: harness.memoryRoot, runId: expect.any(String) });
			const argvArgs = vi.mocked(buildWorkerArgv).mock.calls.at(-1)![0];
			expect(argvArgs.model).toEqual(harness.runtime.config.models.consolidator);
			expect(argvArgs.sessionName).toMatch(/^om-consolidator-/);
			// The prompt carries the overflow observation, not the one that stays in the pool.
			expect(argvArgs.kickoffPrompt).toContain("old observation");
			expect(argvArgs.kickoffPrompt).not.toContain("new observation");

			expect(harness.appended).toHaveLength(1);
			expect(harness.appended[0].customType).toBe(OM_OBSERVATIONS_DROPPED);
			expect(harness.appended[0].data).toEqual({
				observationTimestamps: [OLD_OBS.timestamp],
				coversUpToId: "a1",
			});

			const index = readFileSync(join(harness.memoryRoot, "INDEX.md"), "utf-8");
			expect(index).toContain("## Auth");
			expect(index).toContain("how login works");

			expect(harness.notifications.some((n) => n.message === "om: consolidator started (1 obs, ~10 tok)")).toBe(true);
			expect(harness.notifications.some((n) => n.message === "om: consolidator promoted 1 obs" && n.level === "info")).toBe(true);
			expect(harness.runtime.consolidatorController).toBeUndefined();
		});

		it("drops only what is STILL active after the run, so a concurrent commit is never tombstoned", async () => {
			const harness = register(makeHarness({ branch: ledgerBranch([OLD_OBS, NEW_OBS]) }));
			vi.mocked(spawnWorker).mockImplementation(() => {
				// Another writer tombstones the promoted observation while the worker runs.
				(harness.ctx.sessionManager.getBranch() as TestEntry[]).push(
					observationsDroppedEntry("drop-race", {
						observationTimestamps: [OLD_OBS.timestamp],
						coversUpToId: "a1",
					}),
				);
				return Promise.resolve({ code: 0, signal: null, stderr: "" });
			});

			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			await settleDispatch(harness);

			// Nothing left of the handed batch is still active: no tombstone entry is written.
			expect(harness.appended).toHaveLength(0);
			expect(existsSync(join(harness.memoryRoot, "INDEX.md"))).toBe(true);
			expect(harness.notifications.some((n) => n.message === "om: consolidator promoted 0 obs")).toBe(true);
		});

		it("writes no tombstone when the branch has no source entry to anchor coversUpToId", async () => {
			const harness = register(
				makeHarness({ branch: ledgerBranch([OLD_OBS, NEW_OBS], { withSourceEntries: false }) }),
			);
			vi.mocked(spawnWorker).mockResolvedValue({ code: 0, signal: null, stderr: "" });

			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			await settleDispatch(harness);

			expect(harness.appended).toHaveLength(0);
			expect(existsSync(join(harness.memoryRoot, "INDEX.md"))).toBe(true);
		});

		it("stays silent on the toast path when there is no UI", async () => {
			const harness = register(makeHarness({ branch: ledgerBranch([OLD_OBS, NEW_OBS]), hasUI: false }));
			vi.mocked(spawnWorker).mockResolvedValue({ code: 0, signal: null, stderr: "" });

			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			await vi.waitFor(() => expect(harness.runtime.consolidatorInFlight).toBe(false));

			expect(harness.appended).toHaveLength(1);
			expect(harness.notifications).toHaveLength(0);
		});

		it("works without a getContextUsage provider when the host omits it", async () => {
			const harness = register(
				makeHarness({ branch: ledgerBranch([OLD_OBS, NEW_OBS]), withContextUsage: false }),
			);
			vi.mocked(spawnWorker).mockResolvedValue({ code: 0, signal: null, stderr: "" });

			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			await settleDispatch(harness);

			expect(harness.appended).toHaveLength(1);
		});
	});

	describe("failure path", () => {
		it("records the error, keeps the spend, and releases the in-flight flag", async () => {
			const harness = register(
				makeHarness({ branch: [...ledgerBranch([OLD_OBS, NEW_OBS]), unknownCustomEntry("x1", "om.other")] }),
			);
			vi.mocked(readWorkerCost).mockReturnValue({ costUsd: 0.25 });
			vi.mocked(spawnWorker).mockResolvedValue({ code: 3, signal: null, stderr: "model exploded" });

			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			await settleDispatch(harness);

			expect(harness.runtime.lastWorkerError).toBe("consolidator exited with code 3: model exploded");
			// Cost is captured before the exit-code check, so a failed run still lands in the ledger.
			expect(harness.appended.map((a) => a.customType)).toContain(OM_COST);
			expect(harness.notifications).toContainEqual({
				message: "om: consolidator failed: consolidator exited with code 3: model exploded",
				level: "error",
			});
			expect(harness.runtime.consolidatorInFlight).toBe(false);
			expect(harness.runtime.consolidatorController).toBeUndefined();
		});

		it("reports a bare exit code when the worker left no stderr", async () => {
			const harness = register(makeHarness({ branch: ledgerBranch([OLD_OBS, NEW_OBS]) }));
			vi.mocked(spawnWorker).mockResolvedValue({ code: 1, signal: null, stderr: "" });

			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			await settleDispatch(harness);

			expect(harness.runtime.lastWorkerError).toBe("consolidator exited with code 1");
		});

		it("stringifies a non-Error rejection rather than crashing the dispatch", async () => {
			const harness = register(makeHarness({ branch: ledgerBranch([OLD_OBS, NEW_OBS]) }));
			vi.mocked(spawnWorker).mockRejectedValue("spawn blew up");

			evaluateConsolidatorTrigger(harness.pi, harness.runtime, harness.ctx);
			await settleDispatch(harness);

			expect(harness.runtime.lastWorkerError).toBe("spawn blew up");
			expect(harness.notifications).toContainEqual({
				message: "om: consolidator failed: spawn blew up",
				level: "error",
			});
		});
	});
});
