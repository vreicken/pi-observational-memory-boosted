import type {
	CompactionEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
	TurnEndEvent,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { rawTokensSinceLastCompaction, type Entry } from "../ledger/index.js";
import type { Runtime } from "../runtime.js";
import { prepareCompactionDraft } from "./compaction-hook.js";

/** Pi's retryable-error detection: don't compact between an auto-retried turn's attempts. */
const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function contextPressureTokens(ctx: ExtensionContext, threshold: number): { tokens: number; due: boolean } {
	const live = ctx.getContextUsage?.()?.tokens;
	if (live != null) return { tokens: live, due: live >= threshold };
	const raw = rawTokensSinceLastCompaction(ctx.sessionManager.getBranch() as Entry[]);
	return { tokens: raw, due: raw >= threshold };
}

/**
 * Did this `turn_end` leave pending work — i.e. will the agent loop run another turn?
 *
 * The agent loop continues after a turn iff that turn issued tool calls (whose results are fed
 * back). pi hands us those results on the event, so a non-empty `toolResults` means "mid-run";
 * an empty one means this `turn_end` IS the run's terminal turn (equivalent to `agent_end`).
 * We use that to decide whether compaction continues the run.
 */
function turnWillContinue(event: TurnEndEvent): boolean {
	if (Array.isArray(event.toolResults) && event.toolResults.length > 0) return true;
	// Fallback for shapes without toolResults: an assistant that stopped to call tools.
	// (pi's StopReason for tool calls is "toolUse" — see pi-ai types.)
	const message = event.message;
	return message.role === "assistant" && message.stopReason === "toolUse";
}

/**
 * Trigger compaction at the actionable `turn_end` boundary once live context usage crosses
 * `compactAtContextTokens`.
 *
 * The handler is an actionable boundary (pi >= 0.87): it may append structural entries and
 * request one continuation. We render the compaction entry here through the shared preparation
 * (wait for in-flight observers per design R5, snap the cutoff to an observation watermark,
 * render journey + memory map + observation pool) and hand it back as a boundary draft:
 *
 *   { entries: [...event.entries, compactionDraft], continue: shouldResume }
 *
 * pi applies the draft via `appendCompaction` and — when continuing — issues the next provider
 * request against the freshly compacted projection. No abort, no chat pause, and crucially no
 * synthetic resume turn: the pre-0.87 flow needed a hidden custom message mimicking a user turn
 * to restart the agent after `ctx.compact()` disconnected the loop; the boundary continuation
 * the boundary continuation does it agent-invisibly.
 *
 * A terminal turn (no pending tool work) gets the compaction entry without a continuation —
 * the run ends exactly as if no compaction had happened, and any future request starts from
 * the compacted context.
 */
export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", async (event, ctx): Promise<TurnEndEventResult | void> => {
		if (!runtime.enabled || runtime.config.passive) return;
		if (runtime.compactInFlight) return;

		// Don't compact if pi will auto-retry this turn (transient provider/network error).
		const message = event?.message;
		if (
			message?.role === "assistant" &&
			message.stopReason === "error" &&
			message.errorMessage &&
			RETRYABLE_ERROR_RE.test(message.errorMessage)
		) {
			return;
		}

		if (!contextPressureTokens(ctx, runtime.config.compactAtContextTokens).due) return;

		// Continuation is decided NOW, from this turn's event: `turn_end` had pending tool work.
		// Terminal turns stop anyway; continuing one would create more work, not resume lost work.
		const shouldResume = runtime.config.resumeAfterMidRunCompaction && turnWillContinue(event);

		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		runtime.compactInFlight = true;
		if (hasUI) ui?.notify("om: context threshold reached — compacting (waiting for in-flight observers)…", "info");

		try {
			const draft = await prepareCompactionDraft(
				{
					getBranch: () => ctx.sessionManager.getBranch() as Entry[],
					notify: hasUI ? (text, level) => ui?.notify(text, level) : undefined,
				},
				runtime,
			);

			const compactionDraft: CompactionEntryDraft = {
				type: "compaction",
				summary: draft.summary,
				firstKeptEntryId: draft.firstKeptEntryId,
				details: draft.details,
			};
			const entries: SessionBoundaryDraft[] = [...(event.entries ?? []), compactionDraft];

			if (hasUI) ui?.notify("om: compaction complete", "info");
			// Only request a continuation the loop would not schedule itself: a mid-run turn.
			// Returning `continue: false` on a naturally-continuing turn is harmless, but asking
			// for one on a terminal turn would resurrect a stopped run — so the guard above is
			// load-bearing.
			return { entries, continue: shouldResume };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			runtime.lastWorkerError = `compaction failed: ${msg}`;
			if (hasUI) ui?.notify(`om: compaction failed — ${msg}`, "error");
			return undefined;
		} finally {
			runtime.compactInFlight = false;
		}
	});
}
