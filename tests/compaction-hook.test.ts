import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { registerCompactionHook, boundaryTailProposal, canSkipObserverWait } from "../src/hooks/compaction-hook.js";
import { Runtime } from "../src/runtime.js";
import {
	observation,
	observationsRecordedEntry,
	rawMessage,
	toolResultMessage,
	unknownCustomEntry,
	type TestEntry,
} from "./fixtures/session.js";

// 40 chars ⇒ ~10 estimated tokens per source message.
const body = "x".repeat(40);

type Notification = { message: string; level?: "info" | "warning" | "error" };
type CtxStub = {
	hasUI: boolean;
	cwd: string;
	/** Absent on a headless context (ctx.hasUI false) — the hook must not need it. */
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
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
		// The branch is mutable: an observer commits a new chunk while compaction waits, which is
		// exactly the state the pre-wait snap cannot see. A run that skipped the re-read (or just
		// reused the pre-wait snap) would keep the older cut and lose the just-committed block.
		const live: TestEntry[] = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", {
				observations: [observation("2026-05-02T10:00:01", { content: "early" })],
				coversUpToId: "raw-2",
			}),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
		];
		const harness = makeHarness({ branch: live });
		harness.runtime.memoryRoot = join(root, ".memory", "sess-1");
		harness.runtime.config.tailTokens = 5; // pre-wait snapped tail 20 > 5 ⇒ not stable ⇒ wait
		harness.runtime.trackObserverTask(
			(async () => {
				// Commit AFTER compaction is already suspended in its observer wait — a synchronous
				// push here would have landed before the pre-wait snap was even taken.
				await new Promise((resolve) => setImmediate(resolve));
				live.push(
					observationsRecordedEntry("om-2", {
						observations: [observation("2026-05-02T10:05:00", { content: "late" })],
						coversUpToId: "raw-4",
					}),
					rawMessage("raw-5", body),
					rawMessage("raw-6", body),
				);
			})(),
		);

		const result = (await harness.handler(event(live), harness.ctx)) as {
			compaction: { summary: string; firstKeptEntryId: string };
		};

		expect(harness.runtime.lastCompactionObserverWait).toBe("waited");
		expect(harness.notifications).toEqual([
			{ message: "om: waiting for in-flight observers before folding…", level: "info" },
		]);
		// Post-wait branch: the new chunk boundary at raw-4 makes raw-5 the closest cut; the
		// pre-wait snap (boundary at raw-2) would have kept raw-3.
		expect(result.compaction.firstKeptEntryId).toBe("raw-5");
		expect(result.compaction.summary).toContain("early");
		expect(result.compaction.summary).toContain("late");
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

	it("ignores a committed chunk whose coversUpToId is not on the branch", async () => {
		// /tree navigation (or an eviction/rollback) can leave a chunk pointing at an entry the
		// active branch no longer holds. That chunk cannot mark a cutoff — folding it into the
		// summary would render observations for content the model may still see verbatim.
		const branch: TestEntry[] = [
			rawMessage("raw-1", body),
			observationsRecordedEntry("om-ghost", {
				observations: [observation("2026-05-02T10:00:01", { content: "ghost-observation" })],
				coversUpToId: "not-on-this-branch",
			}),
			rawMessage("raw-2", body),
			rawMessage("raw-3", body),
		];
		const harness = makeHarness({ branch });
		harness.runtime.memoryRoot = join(root, ".memory", "sess-1");

		const result = (await harness.handler(
			{ ...event(branch), preparation: { firstKeptEntryId: "raw-3", tokensBefore: 100 } } as unknown as SessionBeforeCompactEvent,
			harness.ctx,
		)) as { compaction: { summary: string; firstKeptEntryId: string } };

		// No boundary qualifies ⇒ pi's proposed cutoff stands verbatim.
		expect(result.compaction.firstKeptEntryId).toBe("raw-3");
		// An unstable snap (no tail measurement) always waits rather than claiming a skip.
		expect(harness.runtime.lastCompactionObserverWait).toBe("waited");
		expect(result.compaction.summary).not.toContain("ghost-observation");
	});

	it("skips a chunk boundary whose next source entry is a tool result", async () => {
		// A tool call and its result must never be split by the cutoff: the boundary after om-1 is
		// followed by a tool result, so it cannot start the kept tail. The later boundary (om-2,
		// followed by a user message) is the one that can.
		const branch: TestEntry[] = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", {
				observations: [observation("2026-05-02T10:00:01", { content: "early" })],
				coversUpToId: "raw-2",
			}),
			// A non-source entry, then the tool result: neither can start the kept tail.
			unknownCustomEntry("marker-1", "pi.provenance", { at: 1 }),
			toolResultMessage("tool-1", body),
			rawMessage("raw-3", body),
			observationsRecordedEntry("om-2", {
				observations: [observation("2026-05-02T10:05:00", { content: "late" })],
				coversUpToId: "raw-3",
			}),
			rawMessage("raw-4", body),
		];
		const harness = makeHarness({ branch });
		harness.runtime.memoryRoot = join(root, ".memory", "sess-1");
		harness.runtime.config.tailTokens = 5;

		const result = (await harness.handler(
			{ ...event(branch), preparation: { firstKeptEntryId: "raw-4", tokensBefore: 100 } } as unknown as SessionBeforeCompactEvent,
			harness.ctx,
		)) as { compaction: { summary: string; firstKeptEntryId: string } };

		expect(result.compaction.firstKeptEntryId).toBe("raw-4");
		expect(result.compaction.summary).toContain("early");
		expect(result.compaction.summary).toContain("late");
	});

	it("cancels a duplicate headless compaction without touching the guard", async () => {
		const harness = makeHarness();
		harness.runtime.memoryRoot = join(root, ".memory", "sess-1");
		harness.runtime.compactHookInFlight = true;
		delete harness.ctx.ui;
		harness.ctx.hasUI = false;

		expect(await harness.handler(event(branchFixture()), harness.ctx)).toEqual({ cancel: true });
		expect(harness.runtime.compactHookInFlight).toBe(true);
	});

	it("renders a headless compaction with no ui to notify", async () => {
		const harness = makeHarness();
		harness.runtime.memoryRoot = join(root, ".memory", "sess-1");
		harness.runtime.config.tailTokens = 5; // forces the wait — whose progress notify has no ui
		delete harness.ctx.ui;
		harness.ctx.hasUI = false;

		const result = (await harness.handler(event(branchFixture()), harness.ctx)) as {
			compaction: { firstKeptEntryId: string };
		};

		expect(result.compaction.firstKeptEntryId).toBe("raw-5");
		expect(harness.runtime.compactHookInFlight).toBe(false);
		expect(harness.notifications).toEqual([]);
	});
});

describe("boundary helpers", () => {
	it("refuses to propose a kept start for a branch with no source entries", () => {
		expect(() => boundaryTailProposal([], 20)).toThrow("branch has no source entries to compact");
		expect(() => boundaryTailProposal([observationsRecordedEntry("om-1", { observations: [observation("t")], coversUpToId: "x" })], 20)).toThrow(
			"branch has no source entries to compact",
		);
	});

	it("proposes the entry that leaves a tail within the budget", () => {
		const branch = [rawMessage("raw-1", body), rawMessage("raw-2", body), rawMessage("raw-3", body)];

		// 40 chars ≈ 10 tokens each; a 15-token budget fits only the last two entries' worth.
		expect(boundaryTailProposal(branch, 15)).toBe("raw-2");
		expect(boundaryTailProposal(branch, 1_000)).toBe("raw-3");
	});

	it("proposes past a tool result (and past non-source entries) to a real cut point", () => {
		// A tool result may not start the kept tail — a cut there would orphan the result from its
		// call. The proposal has to walk past it to the next legal boundary.
		const branch = [
			rawMessage("raw-1", body),
			unknownCustomEntry("marker-1", "pi.provenance", { at: 1 }),
			toolResultMessage("tool-1", body),
			rawMessage("raw-2", body),
			rawMessage("raw-3", body),
		];

		// Tail past raw-1 is ~30 (marker is non-source, so it weighs nothing): over the budget.
		expect(boundaryTailProposal(branch, 20)).toBe("raw-2");
	});

	it("waits whenever it cannot prove the snap stable", () => {
		const branch = [rawMessage("raw-1", body), rawMessage("raw-2", body)];

		// No tail measurement (no qualifying boundary) — nothing to reason about.
		expect(canSkipObserverWait(branch, "raw-2", undefined, 20_000, [])).toBe(false);
		// The kept entry is not on the branch: the cutoff index is unknown.
		expect(canSkipObserverWait(branch, "gone", 5, 20_000, [])).toBe(false);
		// Tail larger than the target: a just-committed boundary could still improve it.
		expect(canSkipObserverWait(branch, "raw-2", 30, 20, [])).toBe(false);
		// An in-flight observer whose chunk ends before the cutoff can still fold into the block.
		expect(canSkipObserverWait(branch, "raw-2", 5, 20_000, [{ coversUpToId: "raw-1" }])).toBe(false);
		// A stable snap plus observers working the tail region is the one provable skip.
		expect(canSkipObserverWait(branch, "raw-2", 5, 20_000, [{ coversUpToId: "raw-2" }])).toBe(true);
	});
});
