import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rawTokensSinceLastCompaction, type Entry } from "../ledger/index.js";
import type { Runtime } from "../runtime.js";

/** Pi's retryable-error detection: don't compact between an auto-retried turn's attempts. */
const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function contextPressureTokens(
	ctx: { getContextUsage?: () => { tokens: number | null } | undefined; sessionManager: { getBranch: () => Entry[] } },
	threshold: number,
): { tokens: number; due: boolean } {
	const live = ctx.getContextUsage?.()?.tokens;
	if (live != null) return { tokens: live, due: live >= threshold };
	const raw = rawTokensSinceLastCompaction(ctx.sessionManager.getBranch());
	return { tokens: raw, due: raw >= threshold };
}

/**
 * Trigger compaction on `turn_end` once live context usage crosses `compactAtContextTokens`.
 *
 * We fire on turn_end (not agent_end) so compaction can kick in BETWEEN turns — pausing the
 * chat immediately — rather than only after the whole agent run settles. We call `ctx.compact()`
 * straight away (no idle gating): waiting for in-flight observers happens inside the
 * `session_before_compact` hook, so the chat is already paused while the observers finish and
 * the rendered block reflects settled memory state (design R5).
 */
export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("turn_end", (event: any, ctx: any) => {
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

		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		runtime.compactInFlight = true;
		if (hasUI) ui?.notify("om: context threshold reached — compacting (waiting for in-flight observers)…", "info");

		// Fire-and-forget. The before-compact hook waits for observers and renders the block.
		ctx.compact({
			onComplete: () => {
				runtime.compactInFlight = false;
				if (hasUI) ui?.notify("om: compaction complete", "info");
			},
			onError: (error: { message: string }) => {
				runtime.compactInFlight = false;
				if (error.message === "Compaction cancelled") return;
				if (hasUI) ui?.notify(`om: ${error.message}`, "error");
			},
		});
	});
}
