import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderMemoryMap } from "../memory/index-render.js";
import { listTopics, readJourney } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	entryIndexById,
	isObservationsRecordedEntry,
	isSourceEntry,
	isValidCutPoint,
	rawTokensAfterIndex,
	renderSummary,
	type Entry,
} from "../ledger/index.js";

/** Distinct, branch-resolved coversUpToId indices of committed observation chunks, ascending. */
function chunkBoundaryIndices(branch: Entry[]): number[] {
	const indexes = entryIndexById(branch);
	const set = new Set<number>();
	for (const entry of branch) {
		if (!isObservationsRecordedEntry(entry)) continue;
		const idx = indexes.get(entry.data.coversUpToId);
		if (idx !== undefined) set.add(idx);
	}
	return Array.from(set).sort((a, b) => a - b);
}

/** First source entry after `boundaryIndex` that is a valid cut point, or undefined. */
function firstKeptAfterBoundary(branch: Entry[], boundaryIndex: number): Entry | undefined {
	for (let i = boundaryIndex + 1; i < branch.length; i++) {
		if (!isSourceEntry(branch[i])) continue;
		return isValidCutPoint(branch[i]) ? branch[i] : undefined;
	}
	return undefined;
}

/**
 * Snap pi's proposed `firstKeptEntryId` to an observation chunk boundary so the verbatim tail
 * starts exactly where a chunk ends — no chunk straddles the cutoff, so nothing is both
 * rendered into the summary and kept verbatim (and nothing is lost). Among boundaries whose
 * next entry is a valid cut point, pick the one whose resulting tail is closest to
 * `tailTokens`. Falls back to pi's proposal when no boundary qualifies (`tail` undefined).
 *
 * Mid-cycle-eviction note (evictObservedEntries): on a branch that contains `context_edit`
 * omissions the snap is unaffected positionally — chunk boundaries are source entries
 * (context_edit entries are non-source and skip cleanly), and the OM compaction block folds
 * ONLY `om.observations.recorded`/`dropped` custom entries, so an omitted source can neither
 * double-represent in the summary nor in `details` (which is a MemoryDetails blob only).
 * The raw-token tail estimates below count EVICTED (omitted) entries too, so measured tails
 * run LARGER than the model-visible tail — the snap can therefore cut deeper than the visible
 * geometry suggests. That direction is safe for eviction (deeper cuts fold MORE, never less),
 * but it means eviction must never target spans inside the measured tail: the eviction policy's
 * own verbatim-tail guard (src/ledger/eviction.ts) requires a span's depth ≥ `tailTokens`
 * with this same raw gauge.
 */
export function snapCutoff(
	branch: Entry[],
	proposedFirstKeptId: string,
	tailTokens: number,
): { firstKeptId: string; tail: number | undefined } {
	const boundaries = chunkBoundaryIndices(branch);
	let bestId: string | undefined;
	let bestTail: number | undefined;
	let bestDelta = Number.POSITIVE_INFINITY;

	for (const boundaryIndex of boundaries) {
		const firstKept = firstKeptAfterBoundary(branch, boundaryIndex);
		if (!firstKept) continue;
		const tail = rawTokensAfterIndex(branch, boundaryIndex);
		const delta = Math.abs(tail - tailTokens);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestId = firstKept.id;
			bestTail = tail;
		}
	}

	return bestId ? { firstKeptId: bestId, tail: bestTail } : { firstKeptId: proposedFirstKeptId, tail: undefined };
}

export function snapFirstKeptEntryId(branch: Entry[], proposedFirstKeptId: string, tailTokens: number): string {
	return snapCutoff(branch, proposedFirstKeptId, tailTokens).firstKeptId;
}

/**
 * Fast-path test: can compaction skip waiting for in-flight observers entirely?
 *
 * The wait exists so just-committed observations are folded before rendering. But an observer
 * only affects the rendered block if its chunk's `coversUpToId` lands at-or-before the cutoff
 * (the projection includes an `om.observations.recorded` entry iff its coverage index is
 * `< index(firstKeptId)` — see `buildCompactionProjection`'s `beforeEntry` boundary). Observers
 * working a chunk in the verbatim tail are excluded regardless, so waiting for them is dead time.
 *
 * Two conditions must hold for a truly no-op skip (identical block AND identical cutoff):
 *  1. No in-flight observer has `coversUpToId` strictly before the cutoff entry (none can enter
 *     the projection). Unresolved ids are treated conservatively as "before" → wait.
 *  2. The snapped cutoff's tail is already `<= tailTokens`. Then committing the (tail-region)
 *     skipped observers can only produce SMALLER tails (further from target), so the snap is
 *     provably stable. If the tail is `> tailTokens` (nothing committed near the tip), a
 *     just-committed tail boundary could become a better snap target — so we wait, which also
 *     yields a tighter tail.
 */
export function canSkipObserverWait(
	branch: Entry[],
	snappedFirstKeptId: string,
	snappedTail: number | undefined,
	tailTokens: number,
	observersInFlight: Iterable<{ coversUpToId: string }>,
): boolean {
	// Condition 2: snap is only stable under skipped observers when its tail is already <= target.
	if (snappedTail === undefined || snappedTail > tailTokens) return false;

	const indexes = entryIndexById(branch);
	const cutoffIndex = indexes.get(snappedFirstKeptId);
	if (cutoffIndex === undefined) return false; // can't reason about the boundary → wait

	// Condition 1: every in-flight observer must cover a chunk that ends at-or-after the cutoff.
	for (const { coversUpToId } of observersInFlight) {
		const idx = indexes.get(coversUpToId);
		if (idx === undefined || idx < cutoffIndex) return false;
	}
	return true;
}

/**
 * Branch + notification surface needed to prepare a compaction. Both call sites feed this:
 * the `session_before_compact` hook (pi-proposed cutoff, dedupe guard) and the actionable
 * `turn_end` boundary (no proposal — the fallback estimator supplies one).
 */
export type CompactionPreparationInputs = {
	/** Current branch, resolved lazily (a re-read happens after the observer wait). */
	getBranch: () => Entry[];
	/** pi's proposed `firstKeptEntryId` when the compaction originated from pi's own preparation. */
	proposedFirstKeptEntryId?: string;
	notify?: (message: string, level?: "info" | "warning" | "error") => void;
};

export type CompactionDraft = {
	summary: string;
	firstKeptEntryId: string;
	details: unknown;
};

/**
 * Propose a kept-start for the boundary path, where pi has no preparation to borrow. Walk the
 * branch backwards accumulating raw tokens; the kept start is the first valid cut point after
 * the entry where the accumulated tail first fits `tailTokens` (conservatively keeps MORE
 * verbatim than requested, mirroring pi's overflow-preparation spirit).
 */
export function boundaryTailProposal(branch: Entry[], tailTokens: number): string {
	for (let i = branch.length - 2; i >= 0; i--) {
		if (!isSourceEntry(branch[i])) continue;
		if (rawTokensAfterIndex(branch, i) > tailTokens) {
			for (let j = i + 1; j < branch.length; j++) {
				if (isSourceEntry(branch[j]) && isValidCutPoint(branch[j])) return branch[j].id;
			}
		}
	}
	const lastSource = [...branch].reverse().find((entry) => isSourceEntry(entry));
	if (!lastSource) throw new Error("branch has no source entries to compact");
	return lastSource.id;
}

/**
 * Shared compaction preparation: wait for in-flight observers (unless the R5 fast path proves
 * the wait is a no-op), snap the cutoff to a committed chunk boundary, and render the summary
 * block from the observation pool plus the long-term tier read live from disk. Used by the
 * `session_before_compact` hook (pi-initiated / `/om:compact` compactions) and by the
 * actionable `turn_end` boundary (threshold-triggered mid-run compaction).
 */
export async function prepareCompactionDraft(
	inputs: CompactionPreparationInputs,
	runtime: Runtime,
): Promise<CompactionDraft> {
	const tailTokens = runtime.config.tailTokens;
	const proposal =
		inputs.proposedFirstKeptEntryId ?? boundaryTailProposal(inputs.getBranch(), tailTokens);

	// Compute the snap from the CURRENT (pre-wait) branch. The snap only reads committed
	// chunk boundaries (fixed at entry), so this is safe to do before any wait and lets
	// us decide whether the wait is needed at all.
	let branch = inputs.getBranch();
	let snap = snapCutoff(branch, proposal, tailTokens);

	// R5 fast path: skip the wait when no in-flight observer can affect this compaction
	// (its chunk lands in the verbatim tail and the snap is stable). Otherwise wait for
	// observers to settle, then re-read the branch and recompute the snap so just-committed
	// `om.observations.recorded` entries are folded (the pre-wait branch is stale).
	const skip = canSkipObserverWait(branch, snap.firstKeptId, snap.tail, tailTokens, runtime.observersInFlight.values());
	runtime.lastCompactionObserverWait = skip ? "skipped" : "waited";
	if (!skip) {
		inputs.notify?.("om: waiting for in-flight observers before folding…", "info");
		await runtime.whenObserversIdle();
		branch = inputs.getBranch();
		snap = snapCutoff(branch, proposal, tailTokens);
	}

	const snapped = snap.firstKeptId;
	const projection = buildCompactionProjection(branch, snapped);
	// Phase B: render the long-term tier live from disk, regenerated each compaction
	// (throwaway projections — cannot decay). The journey is the running descriptive history
	// the consolidator maintains; the map is the topic-file index.
	const journey = readJourney(runtime.memoryRoot);
	const map = renderMemoryMap(listTopics(runtime.memoryRoot));
	const summary = renderSummary(journey, map, projection.observations);

	return { summary, firstKeptEntryId: snapped, details: projection.details };
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event, ctx) => {
		if (!runtime.enabled || runtime.config.passive) return undefined;

		const hasUI = ctx.hasUI;
		if (runtime.compactHookInFlight) {
			if (hasUI) ctx.ui.notify("om: another compaction is already in progress; cancelling duplicate", "warning");
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { firstKeptEntryId, tokensBefore } = event.preparation;
			const draft = await prepareCompactionDraft(
				{
					getBranch: () =>
						(ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]),
					proposedFirstKeptEntryId: firstKeptEntryId,
					notify: hasUI
						? (message, level) => ctx.ui.notify(message, level)
						: undefined,
				},
				runtime,
			);
			return {
				compaction: {
					summary: draft.summary,
					firstKeptEntryId: draft.firstKeptEntryId,
					tokensBefore,
					details: draft.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
