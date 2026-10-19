/**
 * Mid-cycle eviction policy (task 595e97fc) — the pure, deterministic half of
 * `evictObservedEntries`.
 *
 * Between compactions, raw content that observers have ALREADY fully distilled rides verbatim
 * in projected context and eats quadratic provider cache-read tokens (0.1x per content token,
 * re-read every request). Once a whole turn-span has been observed by a committed chunk, that
 * span can be omitted from future model context via a `context_edit` entry with
 * `replacement: null` — append-only, branch-relative, raw history untouched, zero model
 * involvement.
 *
 * The invariant that makes this safe by construction — omitted-but-unobserved must never be
 * possible, and omitted-but-only-verbally-presented must never be possible either. Coverage is
 * therefore decided where the exact slice is known — observer commit — and candidates are
 * tracked in-process (`Runtime.pendingEvictions`); and the depth guards at flush time keep the
 * span OUTSIDE the verbatim-tail window (`tailTokens`): the observation pool reaches the model
 * ONLY through a compaction summary (OM injects no context of its own), so a span whose
 * covering chunk sits in the tail would lose its raw representation without its distilled one
 * ever reaching the model — omitted in both representations. Never inferred from bare ledger
 * watermarks: parallel observers commit out of order and failed/zero-observation chunks commit
 * no record, so a later watermark does NOT imply earlier entries were observed. After a resume
 * the in-process knowledge is gone and eviction degrades conservatively to a no-op for
 * pre-resume slices (they stay verbatim until compaction — deferred savings, never unsafety).
 */

import { estimateEntryTokens } from "../tokens.js";
import { isObservationsRecordedEntry, type Entry } from "./types.js";
import {
	entryIndexById,
	findLastCompactionIndex,
	isSourceEntry,
	isValidCutPoint,
	rawTokensAfterIndex,
} from "./progress.js";

/**
 * One evictable turn-span selected at observer-commit time: a contiguous run of source
 * entries starting at a user message, wholly contained in the committed slice.
 */
export type EvictionSpan = {
	/** Source-entry ids of the span, in branch order; the first is the span's user message. */
	entryIds: string[];
	/** Id of the committed slice's last source entry — the covering chunk's `coversUpToId`. */
	coversUpToId: string;
	/** Raw-token estimate of the span at selection time; recomputed from the branch at flush. */
	tokens: number;
};

/** A `context_edit` branch entry, as stored by pi's session manager. */
export type ContextEditBranchEntry = Entry & {
	type: "context_edit";
	targetId: string;
	replacement: { content: unknown } | null;
};

export function isContextEditEntry(entry: Entry): entry is ContextEditBranchEntry {
	return entry.type === "context_edit";
}

/**
 * Would pi's `appendContextEdit` accept this entry as a context_edit target? Its editable set:
 * `custom_message`, or `message` with role user / assistant / toolResult. A branch_summary is
 * NOT editable, which is also why branch_summary entries terminate spans but never join them.
 */
export function isEditableContextTarget(entry: Entry): boolean {
	if (entry.type === "custom_message") return true;
	if (entry.type !== "message") return false;
	const role = (entry.message as { role?: string } | undefined)?.role;
	return role === "user" || role === "assistant" || role === "toolResult";
}

function isUserMessage(entry: Entry): boolean {
	if (entry.type !== "message") return false;
	return (entry.message as { role?: string } | undefined)?.role === "user";
}

/** A user message or branch_summary — the entries that LEGITIMATELY start a new turn. */
export function isTurnStarter(entry: Entry): boolean {
	if (entry.type === "branch_summary") return true;
	return isUserMessage(entry);
}

/**
 * Group the entries covered by a committed observer slice into whole turn-spans: user message
 * → before the next user message / branch_summary. Only these spans were fully observed by
 * THIS chunk's observer, so only these may ever be evicted (whole-span omission; no dangling
 * tool calls — an assistant tool call and its results always land in the same span).
 *
 * `branch` supplies the surrounding structure the slice alone cannot: whether the covered
 * range ends at a turn boundary — the motivating case, a chunk whose `coversUpToId` IS the
 * last entry of a completed turn — is decided from the branch source entry that FOLLOWS the
 * range. That entry contributes nothing to coverage: everything the walk may span lies
 * inside the slice.
 *
 * Conservative edges (a miss merely keeps content verbatim until compaction — never unsafe):
 *  - Entries before the covered range's first user message belong to a turn whose user message
 *    sits in an earlier slice → not grouped (the span would straddle the chunk watermark).
 *  - A trailing span is kept only when the source entry after the range is a user message or
 *    branch_summary; if the turn continues past `coversUpToId`, the span straddles the
 *    watermark and is skipped.
 *  - Spans under `minTokens` produce nothing (fast pre-filter; the final size check re-runs on
 *    the live branch at flush time).
 */
export function evictableSpansInSlice(
	branch: Entry[],
	sliceEntries: readonly Entry[],
	minTokens: number,
): EvictionSpan[] {
	if (sliceEntries.length === 0) return [];
	const indexes = entryIndexById(branch);
	const covered = new Set(sliceEntries.map((entry) => entry.id));
	const startIndex = indexes.get(sliceEntries[0].id);
	const endIndex = indexes.get(sliceEntries[sliceEntries.length - 1].id);
	if (startIndex === undefined || endIndex === undefined || startIndex > endIndex) return [];
	// Every span this slice produced shares the same covering chunk: its `coversUpToId` is the
	// watermark the slice ends on — the anchor the flush-time tail guard measures at.
	const coversUpToId = sliceEntries[sliceEntries.length - 1].id;

	const spans: EvictionSpan[] = [];
	let open: { ids: string[]; tokens: number } | undefined;

	const close = () => {
		if (open && open.tokens >= minTokens) {
			spans.push({ entryIds: open.ids, coversUpToId, tokens: open.tokens });
		}
		open = undefined;
	};

	for (let i = startIndex; i <= endIndex; i++) {
		const entry = branch[i];
		if (!isSourceEntry(entry) || !covered.has(entry.id)) continue;
		if (entry.type === "branch_summary") {
			// Summary boundary: it terminates the span but is itself un-evictable.
			close();
			continue;
		}
		if (isUserMessage(entry)) {
			close();
			open = { ids: [entry.id], tokens: estimateEntryTokens(entry) };
			continue;
		}
		if (open) {
			open.ids.push(entry.id);
			open.tokens += estimateEntryTokens(entry);
		}
	}
	// A trailing open span closes only when the covered range ends at a turn boundary — a
	// user message (or branch summary) follows it on the branch. Otherwise the turn continues
	// past the watermark and the span straddles it: leave it verbatim.
	if (open && spanTerminates(branch, endIndex) && open.tokens >= minTokens) {
		spans.push({ entryIds: open.ids, coversUpToId, tokens: open.tokens });
	}

	return spans;
}

export type EvictionFlushInputs = {
	/** Span raw-token total that must be reached before an omission is worth its read-back. */
	minTokens: number;
	/** Depth of the verbatim tail, measured at the covering chunk's boundary (safety anchor). */
	tailTokens: number;
	/** Max raw tokens allowed between the span's end and the branch tip (shallowness guard). */
	windowTokens: number;
	/** Live context usage (or the raw-token fallback); null → imminence guard cannot fire. */
	contextTokens: number | null;
	compactAtContextTokens: number;
	chunkTokens: number;
};

/**
 * Compaction-imminence guard: within this distance of the compaction threshold, compaction is
 * imminent and will fold the tail anyway — evicting then is redundant metadata.
 */
export function isCompactionImminent(inputs: EvictionFlushInputs): boolean {
	if (inputs.contextTokens == null) return false;
	return inputs.contextTokens >= inputs.compactAtContextTokens - 2 * inputs.chunkTokens;
}

/**
 * Does the span terminate on the live branch — i.e. is everything after its last member (a)
 * a user message / branch_summary (the turn ended), or (b) nothing valid at all?
 *
 * A compaction entry before the tip means the span sits in the summarized (already folded)
 * region — omitting it there is redundant, so it is skipped. A branch that simply ends, or an
 * assistant/toolResult continuing the turn past the span, means the span's terminator lies
 * beyond what was committed → skip (conservative).
 */
function spanTerminates(branch: Entry[], lastIndex: number): boolean {
	for (let i = lastIndex + 1; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type === "compaction") return false;
		if (!isSourceEntry(entry)) continue;
		return isTurnStarter(entry);
	}
	return false;
}

/**
 * Is the covering chunk's boundary an actual snap candidate — i.e. would `snapCutoff`'s
 * boundary scan even consider cutting there? It mirrors `firstKeptAfterBoundary` in
 * compaction-hook.ts (kept in sync with it): a boundary qualifies only when its NEXT source
 * entry exists and is a valid cut point; otherwise the snap never cuts at that boundary and
 * the folded region cannot be pinned by it.
 */
function coveringBoundaryIsSnapCandidate(branch: Entry[], coversIndex: number): boolean {
	if (coversIndex + 1 >= branch.length) return false;
	for (let i = coversIndex + 1; i < branch.length; i++) {
		if (!isSourceEntry(branch[i])) continue;
		return isValidCutPoint(branch[i]);
	}
	return false;
}

/**
 * Re-evaluate committed (in-process) eviction candidates against the LIVE branch and keep only
 * those that are currently safe and worthwhile. The checks are CONJUNCTIVE and applied in
 * code order below (the numbers are reference labels, not an execution order); a dropped span
 * merely rides verbatim until compaction — never unsafety:
 *
 *  1. compaction imminent → skip everything;
 *  2. every member still on the ACTIVE branch (stale /tree stray → drop);
 *  3. every member in branch order and individually an editable context target, else the whole
 *     span is dropped (pi validates boundary drafts strictly — one invalid draft drops ALL
 *     extensions' drafts in the dispatch);
 *  4. no member already carries a context_edit on this branch (no duplicate omissions);
 *  5. span still starts at a user message and still terminates here after the re-walk;
 *  5b. the covering chunk's committed `om.observations.recorded` entry must still be on the
 *     ACTIVE branch: coverage was asserted once at commit time, and a /tree rewind can strand
 *     that record on an abandoned branch while the boundary entries survive on the active one
 *     — the record is then unreachable (the fold iterates branch entries only) and the
 *     observer clock will never re-observe the rewound slice (the in-process dispatch marker
 *     still resolves), so the span can never reach the model no matter what;
 *  6. span raw-token total still ≥ minTokens (recomputed from the branch);
 *  7. span end OUTSIDE the verbatim-tail window, measured at the COVERING CHUNK's committed
 *     boundary (`coversUpToId`) — not at the span end. The fold includes an
 *     `om.observations.recorded` chunk only when its coverage index sits rootward of the snap's
 *     kept start, and for a multi-span slice the span end lies rootward of `coversUpToId`: a
 *     span-end measurement can pass the guard while the chunk boundary itself sits inside the
 *     tail window, so the snap lands rootward of the covering chunk and its observation is
 *     excluded from the fold while the span is no longer verbatim either (QA/review pass 2).
 *     The guard uses the SAME raw gauge the snap uses, which makes this provable: snap
 *     candidates deeper than the covering boundary have measured tails ≥ its own, hence a
 *     delta no smaller; candidates tipward of it fold MORE, never less. The observation pool
 *     reaches the model only through the compaction block — an evicted span kept verbatim at
 *     the next snap would sit in NEITHER representation.
 *  8. the covering boundary must also be an ACTUAL snap candidate — the snap skips a chunk
 *     boundary whose next source entry is not a valid cut point and never cuts there, so a
 *     span whose covering chunk cannot be snapped is skipped;
 *  9. span end within windowTokens of the branch tip (the shallowness guard that bounds the
 *     one-time full-price cache-suffix re-read — see README). The COST anchor stays at the
 *     span end: the cost is the suffix behind the omission point, which is where the span ends.
 * 10. span does not sit before the compaction cutoff / under the last compaction's summarized
 *     region (spanTerminates + the kept-tail check below).
 *
 * `span.tokens` on the returned spans is the branch-accurate recompute.
 */
export function filterEvictableSpans(
	branch: Entry[],
	pending: readonly EvictionSpan[],
	inputs: EvictionFlushInputs,
): EvictionSpan[] {
	if (pending.length === 0 || isCompactionImminent(inputs)) return [];

	const indexes = entryIndexById(branch);
	// ANY prior context_edit on a member — omission or replacement — blocks the span: the
	// latest-edit-wins layering is exactly what we do not want to fight over.
	const edited = new Set<string>();
	for (const entry of branch) {
		if (isContextEditEntry(entry)) edited.add(entry.targetId);
	}

	const kept: EvictionSpan[] = [];

	// Covering-chunk presence on the LIVE branch: coverage was asserted once, at commit time —
	// a /tree rewind onto a branch where the boundary entries survive but the
	// `om.observations.recorded` entry does not leaves the observation unreachable (the fold
	// iterates branch entries only, so it can never reach the model), and the observer clock
	// never re-observes the rewound slice because the in-process dispatch marker still resolves
	// on the branch. Requirement (review pass 3): the committed record that covers the span
	// must still be on the ACTIVE branch at flush time, or there is nothing the odomitted span
	// can fall back to.
	const coveringChunks = new Set<string>();
	for (const entry of branch) {
		if (!isObservationsRecordedEntry(entry)) continue;
		coveringChunks.add(entry.data.coversUpToId);
	}

	for (const span of pending) {
		const memberIndexes: number[] = [];
		let valid = true;
		let cursor = -1;
		for (const id of span.entryIds) {
			const index = indexes.get(id);
			if (index === undefined || index <= cursor || !isEditableContextTarget(branch[index]) || edited.has(id)) {
				valid = false;
				break;
			}
			cursor = index;
			memberIndexes.push(index);
		}
		if (!valid || memberIndexes.length === 0) continue;

		const lastIndex = memberIndexes[memberIndexes.length - 1];
		if (!isUserMessage(branch[memberIndexes[0]])) continue;
		if (!spanTerminates(branch, lastIndex)) continue;

		// Safety guard (steps 5b–8): the committed record that covers the span must still be on
		// the ACTIVE branch (see coveringChunks above / AC-2 coverage clause); the tail depth
		// anchors at the covering chunk's committed boundary, and that boundary must be a snap
		// candidate — only then is the fold of its observation guaranteed by the snap's rule.
		if (!coveringChunks.has(span.coversUpToId)) continue;
		const coversIndex = indexes.get(span.coversUpToId);
		if (coversIndex === undefined) continue;
		if (!coveringBoundaryIsSnapCandidate(branch, coversIndex)) continue;
		if (rawTokensAfterIndex(branch, coversIndex) < inputs.tailTokens) continue;

		// Under the last compaction's cutoff everything was already folded into the summary:
		// omitting those entries is redundant metadata. Keep the span only when all its members
		// sit in the compaction's kept verbatim tail (or no compaction exists past it).
		const lastCompactionIndex = findLastCompactionIndex(branch);
		if (lastCompactionIndex > lastIndex) {
			const keptId = (branch[lastCompactionIndex] as { firstKeptEntryId?: string }).firstKeptEntryId;
			const keptIndex = keptId === undefined ? undefined : indexes.get(keptId);
			if (keptIndex === undefined || memberIndexes[0] < keptIndex) continue;
		}

		let tokens = 0;
		for (const index of memberIndexes) tokens += estimateEntryTokens(branch[index]);
		if (tokens < inputs.minTokens) continue;
		// Cost guard only (step 9) — the re-read suffix starts at the omission point, the span end.
		if (rawTokensAfterIndex(branch, lastIndex) > inputs.windowTokens) continue;

		kept.push({ entryIds: [...span.entryIds], coversUpToId: span.coversUpToId, tokens });
	}

	return kept;
}

/** pi-side draft shape (structural mirror of ContextEditEntryDraft from pi's extension types). */
export type ContextEditBranchDraft = {
	type: "context_edit";
	targetId: string;
	replacement: null;
};

/** The boundary drafts that omit one span: one `context_edit` draft per member. */
export function spanEvictionDrafts(span: EvictionSpan): ContextEditBranchDraft[] {
	return span.entryIds.map((targetId) => ({ type: "context_edit" as const, targetId, replacement: null }));
}

/**
 * Eviction surface for /om:status, folded from what THIS process appended: the flusher records
 * every span it emitted as a draft into `Runtime.evictionRecords`, and only those are counted.
 * Branch-derived counting is NOT safe here — pi's own recovery path appends `context_edit`
 * entries with `replacement: null` too (`_omitRecoveryAttempt`), indistinguishable from OM's
 * on the branch, and would be reported as OM evictions. In-process records also degrade
 * consistently: after a resume they (like the slice knowledge) are gone and the tally resets
 * rather than inventing credit.
 */
export function evictionRecordStats(records: readonly EvictionSpan[]): { count: number; tokens: number } {
	let count = 0;
	let tokens = 0;
	for (const record of records) {
		count += record.entryIds.length;
		tokens += record.tokens;
	}
	return { count, tokens };
}

/**
 * Ids that currently carry a `context_edit` OMISSION on the branch. OM's drafts and pi's own
 * recovery omissions both land here — it cannot distinguish authorship, so it is only ever
 * used to CONFIRM records (whose target ids OM chose), never to count credit from scratch.
 */
export function omissionTargetIds(branch: Entry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of branch) {
		if (!isContextEditEntry(entry) || entry.replacement !== null) continue;
		ids.add(entry.targetId);
	}
	return ids;
}

/**
 * Keep only records whose omissions ACTUALLY landed: pi applies a boundary dispatch
 * all-or-nothing, so when another extension's invalid draft fails somewhere in the chain, ALL
 * drafts — OM's included — are dropped and raw entry-based tally must not count them. A
 * record whose omission vanished under /tree (navigated to a pre-edit point) also drops out;
 * re-omitting it would re-record it at a later flush. Under-credit is the safe direction;
 * over-crediting omissions that never landed is what the review pass 2 flagged, and counting
 * applied entries is what removes it.
 */
export function confirmedEvictionSpans(records: readonly EvictionSpan[], omissionTargets: ReadonlySet<string>): EvictionSpan[] {
	return records.filter((record) => record.entryIds.length > 0 && record.entryIds.every((id) => omissionTargets.has(id)));
}
