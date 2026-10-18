import { describe, expect, it } from "vitest";
import type { CompactOptions, ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";

import { registerCompactionTrigger } from "../src/hooks/compaction-trigger.js";
import { OM_RESUME } from "../src/ledger/index.js";
import { Runtime } from "../src/runtime.js";
import { rawMessage, type TestEntry } from "./fixtures/session.js";

type Notification = { message: string; level?: "info" | "warning" | "error" };
type CtxStub = {
	hasUI: boolean;
	ui: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => unknown[] };
	getContextUsage?: () => { tokens: number | null } | undefined;
	compact?: (options?: CompactOptions) => void;
};
type TurnHandler = (event: TurnEndEvent, ctx: CtxStub) => unknown;

type Harness = {
	turn: TurnHandler;
	notifications: Notification[];
	ctx: CtxStub;
	compacted: CompactOptions[];
	sent: Array<{ customType: string; options: unknown }>;
};

function makeHarness(opts: {
	branch?: TestEntry[];
	liveTokens?: number | null | undefined;
	resumeAfter?: boolean;
	passive?: boolean;
	enabled?: boolean;
	inFlight?: boolean;
	sendMessageThrows?: boolean;
}): { runtime: Runtime; harness: Harness } {
	const runtime = new Runtime();
	runtime.enabled = opts.enabled ?? true;
	runtime.configLoaded = true;
	runtime.config.passive = opts.passive ?? false;
	runtime.config.resumeAfterMidRunCompaction = opts.resumeAfter ?? true;
	runtime.config.compactAtContextTokens = 100;
	runtime.compactInFlight = opts.inFlight ?? false;

	const notifications: Notification[] = [];
	const compacted: CompactOptions[] = [];
	const sent: Array<{ customType: string; options: unknown }> = [];
	const ctx: CtxStub = {
		hasUI: true,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
		sessionManager: { getBranch: () => opts.branch ?? [] },
		getContextUsage: () => (opts.liveTokens === undefined ? undefined : { tokens: opts.liveTokens ?? null }),
		compact: (options) => compacted.push(options ?? {}),
	};

	let registered: TurnHandler | undefined;
	const pi = {
		on: (event: string, handler: TurnHandler) => {
			if (event === "turn_end") registered = handler;
		},
		sendMessage: (message: { customType: string }, options: unknown) => {
			if (opts.sendMessageThrows) throw new Error("channel closed");
			sent.push({ customType: message.customType, options });
		},
	} as unknown as ExtensionAPI;

	registerCompactionTrigger(pi, runtime);
	if (!registered) throw new Error("turn_end handler was not registered");
	return { runtime, harness: { turn: registered, notifications, ctx, compacted, sent } };
}

function turnEvent(overrides: { toolResults?: TestEntry[]; message?: unknown } = {}): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: overrides.message ?? { role: "user", content: "hi" },
		toolResults: overrides.toolResults ?? [],
	} as unknown as TurnEndEvent;
}

describe("registerCompactionTrigger gates", () => {
	it("does nothing while om is disabled", () => {
		const { harness } = makeHarness({ enabled: false, liveTokens: 9999 });
		harness.turn(turnEvent(), harness.ctx);
		expect(harness.compacted).toHaveLength(0);
	});

	it("does nothing in passive mode", () => {
		const { harness } = makeHarness({ passive: true, liveTokens: 9999 });
		harness.turn(turnEvent(), harness.ctx);
		expect(harness.compacted).toHaveLength(0);
	});

	it("does nothing when a compaction is already in flight", () => {
		const { harness } = makeHarness({ inFlight: true, liveTokens: 9999 });
		harness.turn(turnEvent(), harness.ctx);
		expect(harness.compacted).toHaveLength(0);
	});

	it("skips a turn pi will auto-retry on a transient provider error", () => {
		const { harness } = makeHarness({ liveTokens: 9999 });
		harness.turn(
			turnEvent({ message: { role: "assistant", stopReason: "error", errorMessage: "upstream returned error: 503" } }),
			harness.ctx,
		);
		expect(harness.compacted).toHaveLength(0);
	});

	it("does not compact while usage is below the threshold", () => {
		const { harness } = makeHarness({ liveTokens: 99 });
		harness.turn(turnEvent(), harness.ctx);
		expect(harness.compacted).toHaveLength(0);
	});
});

describe("registerCompactionTrigger firing", () => {
	it("compacts at the threshold and resumes after a mid-run (tool-calling) turn", () => {
		const { runtime, harness } = makeHarness({ liveTokens: 500 });
		harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);

		expect(runtime.compactInFlight).toBe(true);
		expect(harness.compacted).toHaveLength(1);
		expect(harness.notifications[0].message).toContain("context threshold reached");

		harness.compacted[0].onComplete?.({} as never);
		expect(runtime.compactInFlight).toBe(false);
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0].customType).toBe(OM_RESUME);
		expect(harness.sent[0].options).toEqual({ triggerTurn: true });
	});

	it("does not resume when the compacted turn was terminal", () => {
		const { runtime, harness } = makeHarness({ liveTokens: 500 });
		harness.turn(turnEvent({ message: { role: "assistant", stopReason: "stop" } }), harness.ctx);

		harness.compacted[0].onComplete?.({} as never);
		expect(runtime.compactInFlight).toBe(false);
		expect(harness.sent).toHaveLength(0);
	});

	it("falls back to raw branch tokens and the toolUse stopReason when no live usage is exposed", () => {
		// compactAtContextTokens 0 makes the raw-token fallback due on any branch.
		const { runtime, harness } = makeHarness({ liveTokens: undefined, branch: [rawMessage("raw-1", "x".repeat(40))] });
		runtime.config.compactAtContextTokens = 0;
		harness.ctx.getContextUsage = undefined;
		harness.turn(turnEvent({ message: { role: "assistant", stopReason: "toolUse" } }), harness.ctx);

		expect(harness.compacted).toHaveLength(1);
		harness.compacted[0].onComplete?.({} as never);
		expect(harness.sent).toHaveLength(1);
	});

	it("records a resume failure instead of throwing", () => {
		const { runtime, harness } = makeHarness({ liveTokens: 500, sendMessageThrows: true });
		harness.turn(turnEvent({ toolResults: [rawMessage("tr-1", "result")] }), harness.ctx);
		harness.compacted[0].onComplete?.({} as never);

		expect(runtime.lastWorkerError).toContain("resume failed: channel closed");
		expect(harness.notifications.at(-1)).toEqual({ message: "om: resume failed — channel closed", level: "error" });
	});

	it("surfaces a compaction error and clears the guard", () => {
		const { runtime, harness } = makeHarness({ liveTokens: 500 });
		harness.turn(turnEvent(), harness.ctx);
		harness.compacted[0].onError?.(new Error("disk full"));

		expect(runtime.compactInFlight).toBe(false);
		expect(harness.notifications.at(-1)).toEqual({ message: "om: disk full", level: "error" });
	});

	it("treats a cancelled compaction as silent", () => {
		const { runtime, harness } = makeHarness({ liveTokens: 500 });
		harness.turn(turnEvent(), harness.ctx);
		const before = harness.notifications.length;
		harness.compacted[0].onError?.(new Error("Compaction cancelled"));

		expect(runtime.compactInFlight).toBe(false);
		expect(harness.notifications).toHaveLength(before);
	});
});
