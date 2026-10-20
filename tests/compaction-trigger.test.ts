import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionBoundaryDraft, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";

import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { Runtime } from "../src/runtime.js";
import { observation, observationsRecordedEntry, rawMessage, type TestEntry } from "./fixtures/session.js";

type Notification = { message: string; level?: "info" | "warning" | "error" };
type CtxStub = {
	hasUI: boolean;
	/** Absent on a headless context (ctx.hasUI false) — the trigger must not need it. */
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => unknown[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
};
type TurnHandler = (event: TurnEndEvent, ctx: CtxStub) => Promise<TurnEndEventResult | void>;

type Harness = {
	turn: TurnHandler;
	notifications: Notification[];
	ctx: CtxStub;
};

function makeHarness(opts: {
	branch?: TestEntry[];
	liveTokens?: number | null | undefined;
	resumeAfter?: boolean;
	passive?: boolean;
	enabled?: boolean;
	inFlight?: boolean;
	/** true throws an Error, a string throws that non-Error value (the trigger stringifies it). */
	getBranchThrows?: boolean | string;
	headless?: boolean;
}): { runtime: Runtime; harness: Harness } {
	const runtime = new Runtime();
	runtime.enabled = opts.enabled ?? true;
	runtime.configLoaded = true;
	runtime.config.passive = opts.passive ?? false;
	runtime.config.resumeAfterMidRunCompaction = opts.resumeAfter ?? true;
	runtime.config.compactAtContextTokens = 100;
	runtime.compactInFlight = opts.inFlight ?? false;

	const notifications: Notification[] = [];
	const memoryRoot = mkdtempSync(join(tmpdir(), "om-trigger-"));
	createdTempRoots.push(memoryRoot);
	runtime.memoryRoot = join(memoryRoot, ".memory", "sess-1");
	const ctx: CtxStub = {
		hasUI: !opts.headless,
		sessionManager: {
			getBranch: () => {
				if (typeof opts.getBranchThrows === "string") throw opts.getBranchThrows;
				if (opts.getBranchThrows) throw new Error("branch exploded");
				return opts.branch ?? [];
			},
		},
		getContextUsage: () => (opts.liveTokens === undefined ? undefined : { tokens: opts.liveTokens ?? null }),
	};
	if (!opts.headless) ctx.ui = { notify: (message, level) => notifications.push({ message, level }) };

	let registered: TurnHandler | undefined;
	const pi = {
		on: (event: string, handler: TurnHandler) => {
			if (event === "turn_end") registered = handler;
		},
	} as unknown as ExtensionAPI;

	registerCompactionTrigger(pi, runtime);
	if (!registered) throw new Error("turn_end handler was not registered");
	return { runtime, harness: { turn: registered, notifications, ctx } };
}

function turnEvent(
	overrides: {
		toolResults?: TestEntry[];
		message?: unknown;
		entries?: SessionBoundaryDraft[];
		/** Drop `entries` entirely, the shape an older/external boundary emitter would hand us. */
		omitEntries?: boolean;
	} = {},
): TurnEndEvent {
	const event: Record<string, unknown> = {
		type: "turn_end",
		turnIndex: 0,
		message: overrides.message ?? { role: "user", content: "hi" },
		toolResults: overrides.toolResults ?? [],
		continue: false,
	};
	if (!overrides.omitEntries) event.entries = overrides.entries ?? [];
	return event as unknown as TurnEndEvent;
}

const createdTempRoots: string[] = [];
afterEach(() => {
	for (const root of createdTempRoots) rmSync(root, { recursive: true, force: true });
	createdTempRoots.length = 0;
});

describe("registerCompactionTrigger gates", () => {
	it("does nothing while om is disabled", async () => {
		const { harness } = makeHarness({ enabled: false, liveTokens: 9999 });
		expect(await harness.turn(turnEvent(), harness.ctx)).toBeUndefined();
	});

	it("does nothing in passive mode", async () => {
		const { harness } = makeHarness({ passive: true, liveTokens: 9999 });
		expect(await harness.turn(turnEvent(), harness.ctx)).toBeUndefined();
	});

	it("does nothing when a compaction is already in flight", async () => {
		const { harness } = makeHarness({ inFlight: true, liveTokens: 9999 });
		expect(await harness.turn(turnEvent(), harness.ctx)).toBeUndefined();
	});

	it("skips a turn pi will auto-retry on a transient provider error", async () => {
		const { harness } = makeHarness({ liveTokens: 9999 });
		const result = await harness.turn(
			turnEvent({ message: { role: "assistant", stopReason: "error", errorMessage: "upstream returned error: 503" } }),
			harness.ctx,
		);
		expect(result).toBeUndefined();
	});

	it("does not compact while usage is below the threshold", async () => {
		const { harness } = makeHarness({ liveTokens: 99 });
		expect(await harness.turn(turnEvent(), harness.ctx)).toBeUndefined();
	});
});

describe("registerCompactionTrigger boundary continuation", () => {
	it("compacts at the threshold and continues after a mid-run (tool-calling) turn", async () => {
		const { runtime, harness } = makeHarness({ liveTokens: 500, branch: [rawMessage("raw-1", "x".repeat(40))] });
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);

		expect(runtime.compactInFlight).toBe(false);
		expect(harness.notifications[0].message).toContain("context threshold reached");
		expect(result?.continue).toBe(true);

		expect(result?.entries).toHaveLength(1);
		const draft = result?.entries?.[0];
		expect(draft?.type).toBe("compaction");
		expect(typeof (draft as { summary: string }).summary).toBe("string");
		expect((draft as { firstKeptEntryId: string }).firstKeptEntryId).toBeTruthy();
		expect(harness.notifications.at(-1)?.message).toContain("compaction complete");
	});

	it("emits only compaction drafts — never a model-visible resume entry", async () => {
		// AC2/AC3 behaviourally: the pre-0.87 flow returned nothing and instead pushed a hidden
		// custom_message whose text reached the provider as a user turn. Whatever the text, a
		// boundary result carrying any custom/custom_message draft would re-open that hole.
		const { harness } = makeHarness({ liveTokens: 500, branch: [rawMessage("raw-1", "x".repeat(40))] });
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);

		const entries = result?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries.map((entry) => entry.type)).toEqual(["compaction"]);
		expect(JSON.stringify(entries)).not.toContain("no user message was sent");
	});

	it("folds the observation pool into the boundary draft and snaps the cut to its chunk", async () => {
		// The draft is rendered by the trigger itself (a boundary compaction never reaches the
		// `session_before_compact` hook), so the folded observations and the `details` blob have
		// to arrive on the draft — otherwise the ledger tier is silently lost at the boundary.
		const branch: TestEntry[] = [
			rawMessage("raw-1", "x".repeat(40)),
			observationsRecordedEntry("om-1", {
				observations: [observation("2026-05-02T10:00:01", { content: "early-folded-observation" })],
				coversUpToId: "raw-1",
			}),
			rawMessage("raw-2", "x".repeat(40)),
			rawMessage("raw-3", "x".repeat(40)),
		];
		const { harness } = makeHarness({ liveTokens: 500, branch });

		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);

		const draft = result?.entries?.[0] as { summary: string; firstKeptEntryId: string; details: unknown };
		// The chunk boundary after om-1 wins over the raw-tail proposal (raw-3): no chunk straddles
		// the cutoff, so the folded observation cannot also ride verbatim.
		expect(draft.firstKeptEntryId).toBe("raw-2");
		expect(draft.summary).toContain("early-folded-observation");
		expect(draft.details).toMatchObject({
			type: "om.folded",
			version: 1,
			observations: [{ timestamp: "2026-05-02T10:00:01", content: "early-folded-observation" }],
		});
	});

	it("does not continue after the compacted turn was terminal", async () => {
		const { harness } = makeHarness({ liveTokens: 500, branch: [rawMessage("raw-1", "x".repeat(40))] });
		const result = await harness.turn(turnEvent({ message: { role: "assistant", stopReason: "stop" } }), harness.ctx);

		expect(result?.entries).toHaveLength(1);
		// Explicitly false, not merely absent: pi's agent loop turns a missing/false `continue`
		// into the same stop, while `true` on a terminal turn would resurrect a stopped run.
		expect(result?.continue).toBe(false);
	});

	it("honors resumeAfterMidRunCompaction=false on a mid-run turn", async () => {
		const { harness } = makeHarness({ liveTokens: 500, resumeAfter: false, branch: [rawMessage("raw-1", "x".repeat(40))] });
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);

		expect(result?.entries).toHaveLength(1);
		expect(result?.continue).toBe(false);
	});

	it("chains draft entries after pi's accumulated boundary entries", async () => {
		const { harness } = makeHarness({ liveTokens: 500, branch: [rawMessage("raw-1", "x".repeat(40))] });
		const piDraft: SessionBoundaryDraft = { type: "custom", customType: "pi.provenance", data: { at: 1 } };
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "r")], entries: [piDraft] }), harness.ctx);

		expect(result?.entries).toHaveLength(2);
		expect(result?.entries?.[0]).toBe(piDraft);
		expect(result?.entries?.[1]?.type).toBe("compaction");
	});

	it("compacts and continues on a headless context with no ui", async () => {
		// Worker/CLI sessions have ctx.hasUI false and no ui at all; the trigger still has to
		// compact and continue instead of throwing on a bare notify call.
		const { runtime, harness } = makeHarness({
			liveTokens: 500,
			headless: true,
			branch: [rawMessage("raw-1", "x".repeat(40))],
		});
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);

		expect(result?.entries).toHaveLength(1);
		expect(result?.continue).toBe(true);
		expect(harness.notifications).toEqual([]);
		expect(runtime.compactInFlight).toBe(false);
	});

	it("tolerates an event with no accumulated boundary entries", async () => {
		const { harness } = makeHarness({ liveTokens: 500, branch: [rawMessage("raw-1", "x".repeat(40))] });
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "r")], omitEntries: true }), harness.ctx);

		expect(result?.entries).toHaveLength(1);
		expect(result?.entries?.[0]?.type).toBe("compaction");
	});

	it("falls back to raw branch tokens and the toolUse stopReason when no live usage is exposed", async () => {
		// compactAtContextTokens 0 makes the raw-token fallback due on any branch.
		const { runtime, harness } = makeHarness({
			liveTokens: undefined,
			branch: [rawMessage("raw-1", "x".repeat(40))],
		});
		runtime.config.compactAtContextTokens = 0;
		harness.ctx.getContextUsage = undefined;
		const result = await harness.turn(turnEvent({ message: { role: "assistant", stopReason: "toolUse" } }), harness.ctx);

		expect(result?.entries).toHaveLength(1);
		expect(result?.continue).toBe(true);
	});

	it("falls back to the single source entry as the kept boundary on a minimal branch", async () => {
		const { harness } = makeHarness({ liveTokens: 500, branch: [rawMessage("raw-1", "unique-body")] });
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "r")] }), harness.ctx);

		const draft = result?.entries?.[0] as { type: string; firstKeptEntryId: string };
		expect(draft.type).toBe("compaction");
		expect(draft.firstKeptEntryId).toBe("raw-1");
	});

	it("records a preparation failure instead of throwing", async () => {
		const { runtime, harness } = makeHarness({ liveTokens: 500, getBranchThrows: true });
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);

		expect(result).toBeUndefined();
		expect(runtime.compactInFlight).toBe(false);
		expect(runtime.lastWorkerError).toContain("compaction failed: branch exploded");
		expect(harness.notifications.at(-1)).toEqual({
			message: "om: compaction failed — branch exploded",
			level: "error",
		});
	});

	it("stringifies a non-Error preparation failure instead of throwing", async () => {
		// Anything on the session-manager path can throw a plain value; a `String(error)` that
		// only handled real Errors would surface "[object Object]" or swallow the cause.
		const { runtime, harness } = makeHarness({ liveTokens: 500, getBranchThrows: "plain string failure" });
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);

		expect(result).toBeUndefined();
		expect(runtime.lastWorkerError).toBe("compaction failed: plain string failure");
		expect(harness.notifications.at(-1)?.message).toBe("om: compaction failed — plain string failure");
	});

	it("records a headless preparation failure without a ui to toast", async () => {
		const { runtime, harness } = makeHarness({ liveTokens: 500, headless: true, getBranchThrows: true });
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);

		expect(result).toBeUndefined();
		expect(runtime.lastWorkerError).toBe("compaction failed: branch exploded");
		expect(runtime.compactInFlight).toBe(false);
		expect(harness.notifications).toEqual([]);
	});
});
