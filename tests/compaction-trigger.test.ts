import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionBoundaryDraft, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";

import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { Runtime } from "../src/runtime.js";
import { rawMessage, type TestEntry } from "./fixtures/session.js";

type Notification = { message: string; level?: "info" | "warning" | "error" };
type CtxStub = {
	hasUI: boolean;
	ui: { notify: (message: string, level?: "info" | "warning" | "error") => void };
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
	getBranchThrows?: boolean;
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
		hasUI: true,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
		sessionManager: {
			getBranch: () => {
				if (opts.getBranchThrows) throw new Error("branch exploded");
				return opts.branch ?? [];
			},
		},
		getContextUsage: () => (opts.liveTokens === undefined ? undefined : { tokens: opts.liveTokens ?? null }),
	};

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
	overrides: { toolResults?: TestEntry[]; message?: unknown; entries?: SessionBoundaryDraft[] } = {},
): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: overrides.message ?? { role: "user", content: "hi" },
		toolResults: overrides.toolResults ?? [],
		entries: overrides.entries ?? [],
		continue: false,
	} as unknown as TurnEndEvent;
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

	it("does not continue after the compacted turn was terminal", async () => {
		const { harness } = makeHarness({ liveTokens: 500, branch: [rawMessage("raw-1", "x".repeat(40))] });
		const result = await harness.turn(turnEvent({ message: { role: "assistant", stopReason: "stop" } }), harness.ctx);

		expect(result?.entries).toHaveLength(1);
		expect(result?.continue).toBeFalsy();
	});

	it("honors resumeAfterMidRunCompaction=false on a mid-run turn", async () => {
		const { harness } = makeHarness({ liveTokens: 500, resumeAfter: false, branch: [rawMessage("raw-1", "x".repeat(40))] });
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);

		expect(result?.entries).toHaveLength(1);
		expect(result?.continue).toBeFalsy();
	});

	it("chains draft entries after pi's accumulated boundary entries", async () => {
		const { harness } = makeHarness({ liveTokens: 500, branch: [rawMessage("raw-1", "x".repeat(40))] });
		const piDraft: SessionBoundaryDraft = { type: "custom", customType: "pi.provenance", data: { at: 1 } };
		const result = await harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "r")], entries: [piDraft] }), harness.ctx);

		expect(result?.entries).toHaveLength(2);
		expect(result?.entries?.[0]).toBe(piDraft);
		expect(result?.entries?.[1]?.type).toBe("compaction");
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
});
