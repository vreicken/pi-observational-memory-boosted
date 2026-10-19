/**
 * Mid-cycle eviction flush (task 595e97fc) — the boundary half of `evictObservedEntries`.
 *
 * Selection happens at observer-commit time (observer-trigger.ts, from the EXACT committed
 * slice); this module merely flushes the in-process candidates at the next actionable
 * boundary, re-checking every guard against the live branch before emitting a single draft.
 *
 * Everything here is deterministic and script-owned — no model call, no LLM involvement. Each
 * draft is `{ type: "context_edit", targetId, replacement: null }`; pi applies it via
 * `appendContextEdit` (branch-relative, raw log untouched) and the target simply stops
 * appearing in future projected context.
 *
 * Registered BEFORE the compaction trigger so an eviction draft chains ahead of any
 * compaction draft in the same dispatch — pi's runner hands each handler the accumulated
 * `entries` array, so both survive and keep their order. Every target is pre-validated here
 * because pi drops ALL boundary drafts of ALL extensions when a single draft fails
 * validation; a stale target must never cost someone else their draft.
 */
import type {
	AgentBeforeSettleEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBoundaryDraft,
	TurnEndEvent,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { confirmedEvictionSpans, filterEvictableSpans, omissionTargetIds, rawTokensSinceLastCompaction, spanEvictionDrafts, type EvictionSpan, type Entry } from "../ledger/index.js";
import type { Runtime } from "../runtime.js";

type FlushContext = ExtensionContext & {
	sessionManager: { getBranch: () => unknown[] };
};

type BoundaryEvent = TurnEndEvent | AgentBeforeSettleEvent;

/** Evaluate in-process eviction candidates against the live branch; returns chains-able drafts. */
export function evaluateEvictionFlush(
	runtime: Runtime,
	event: Pick<BoundaryEvent, "entries">,
	ctx: FlushContext,
): { entries: SessionBoundaryDraft[]; spans: EvictionSpan[] } | undefined {
	// Outermost guards first: no eviction unless om is on, triggers are live, and the flag is on.
	if (!runtime.enabled || runtime.config.passive || !runtime.config.evictObservedEntries) return;
	if (runtime.pendingEvictions.length === 0) return;

	runtime.ensureConfig((ctx as { cwd?: string }).cwd ?? "");
	const branch = ctx.sessionManager.getBranch() as Entry[];
	const contextTokens = ctx.getContextUsage?.()?.tokens ?? rawTokensSinceLastCompaction(branch);

	// Reconcile the tally FIRST, against the live branch: pi applies a boundary dispatch
	// all-or-nothing, so records from a dispatch that failed validation anywhere in the chain
	// never landed and must not be credited (nor must records whose omissions vanished
	// under /tree). Then new spans are appended below as fresh records.
	const confirmed = confirmedEvictionSpans(runtime.evictionRecords, omissionTargetIds(branch));
	runtime.evictionRecords.splice(0, runtime.evictionRecords.length, ...confirmed);

	// Candidates belong to flush #1 (their commit): drained wherever they are evaluated, so
	// nothing accumulates when a guard rejects them. A rejected span simply stays verbatim
	// until the compaction fold — deferred savings, never unsafety.
	const pending = runtime.pendingEvictions.splice(0);
	const spans = filterEvictableSpans(branch, pending, {
		minTokens: runtime.config.evictionMinTokens,
		tailTokens: runtime.config.tailTokens,
		windowTokens: runtime.config.evictionWindowTokens,
		contextTokens,
		compactAtContextTokens: runtime.config.compactAtContextTokens,
		chunkTokens: runtime.config.chunkTokens,
	});

	const drafts = spans.flatMap(spanEvictionDrafts);
	if (drafts.length === 0) return;

	// Chained AFTER the accumulated entries so every other extension's drafts in this dispatch
	// keep their position; we never set `continue` — omission is metadata-only and asks for no
	// continuation turn.
	const entries: SessionBoundaryDraft[] = [...(event?.entries ?? []), ...drafts];
	return { entries, spans };
}

export function registerEvictionFlush(pi: ExtensionAPI, runtime: Runtime): void {
	const handler = (event: BoundaryEvent, ctx: FlushContext): TurnEndEventResult | void => {
		const flushed = evaluateEvictionFlush(runtime, event, ctx);
		if (!flushed) return;

		// Omission record drives /om:status, so the tally counts exactly what OM appended —
		// never pi's own recovery omissions, and never another extension's drafts.
		runtime.evictionRecords.push(...flushed.spans);

		if (ctx.hasUI && ctx.ui) {
			const omitted = flushed.spans.reduce((total, span) => total + span.entryIds.length, 0);
			runtime.queueToast(
				`om: evicted ${omitted} entr${omitted === 1 ? "y" : "ies"} from projected context (observed + oversized)`,
				"info",
				ctx.ui.notify.bind(ctx.ui),
			);
		}
		return { entries: flushed.entries };
	};
	pi.on("turn_end", handler as never);
	pi.on("agent_before_settle", handler as never);
}
