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
 * Trigger compaction at agent_end when live context usage crosses `compactAtContextTokens`,
 * pi is idle, and nothing else is compacting. First waits for in-flight observers so the
 * rendered block reflects settled memory state up to the cutoff (design R5).
 */
export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("agent_end", (event: any, ctx: any) => {
		if (!runtime.enabled || runtime.config.passive) return;
		if (runtime.compactInFlight) return;

		// Don't compact if pi will auto-retry the just-ended turn.
		const lastAssistant = [...event.messages].reverse().find((m: any) => m.role === "assistant");
		if (
			lastAssistant?.stopReason === "error" &&
			lastAssistant.errorMessage &&
			RETRYABLE_ERROR_RE.test(lastAssistant.errorMessage)
		) {
			return;
		}

		const threshold = runtime.config.compactAtContextTokens;
		if (!contextPressureTokens(ctx, threshold).due) return;

		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		runtime.compactInFlight = true;

		void (async () => {
			try {
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					return;
				}
				if (hasUI) ui?.notify("om: waiting for in-flight observers before compaction", "info");
				await runtime.whenObserversIdle();
				if (!ctx.isIdle()) {
					runtime.compactInFlight = false;
					return;
				}
				if (!contextPressureTokens(ctx, threshold).due) {
					runtime.compactInFlight = false;
					return;
				}
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
			} catch (error) {
				runtime.compactInFlight = false;
				const message = error instanceof Error ? error.message : String(error);
				if (hasUI) ui?.notify(`om: compaction trigger threw: ${message}`, "error");
			}
		})();
	});
}
