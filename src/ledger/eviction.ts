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
 * The invariant that makes this safe by construction: an omitted span is one that a committed
 * `om.observations.recorded` chunk observed in full. Coverage is therefore decided where the
 * exact slice is known — observer commit — and candidates are tracked in-process
 * (`Runtime.pendingEvictions`). Nothing is inferred from bare ledger watermarks: parallel
 * observers commit out of order and failed/zero-observation chunks commit no record, so a
 * later watermark does NOT imply earlier entries were observed. After a resume the in-process
 * knowledge is gone and eviction degrades conservatively to a no-op for pre-resume slices
 * (they stay verbatim until compaction — deferred savings, never unsafety).
 */

import { estimateEntryTokens } from "../tokens.js";
import type { Entry } from "./types.js";
import { entryIndexById, findLastCompactionIndex, isSourceEntry, rawTokensAfterIndex } from "./progress.js";

/**
 * One evictable turn-span selected at observer-commit time: a contiguous run of source
 * entries starting at a user message, wholly contained in the committed slice.
 */
export type EvictionSpan = {
	/** Source-entry ids of the span, in branch order; the first is the span's user message. */
	entryIds: string[];
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

/** A branch entry whose `context_edit` omission has been appended (latest edit per target wins). */
export function isContextOmission(entry: Entry): boolean {
	return isContextEditEntry(entry) && entry.replacement === null;
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

	const spans: EvictionSpan[] = [];
	let open: { ids: string[]; tokens: number } | undefined;

	const close = () => {
		if (open && open.tokens >= minTokens) {
			spans.push({ entryIds: open.ids, tokens: open.tokens });
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
		spans.push({ entryIds: open.ids, tokens: open.tokens });
	}

	return spans;
}

export type EvictionFlushInputs = {
	/** Span raw-token total that must be reached before an omission is worth its read-back. */
	minTokens: number;
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
 * Re-evaluate committed (in-process) eviction candidates against the LIVE branch and keep only
 * those that are currently safe and worthwhile. Load-bearing order of rejections — all of
 * them are conservative (an eviction that is dropped merely rides verbatim until compaction):
 *
 *  1. compaction imminent → skip everything;
 *  2. every member still on the ACTIVE branch (stale /tree stray → drop);
 *  3. every member in branch order and individually an editable context target, else the whole
 *     span is dropped (pi validates boundary drafts strictly — one invalid draft drops ALL
 *     extensions' drafts in the dispatch);
 *  4. no member already carries a context_edit on this branch (no duplicate omissions);
 *  5. span still starts at a user message and still terminates here after the re-walk;
 *  6. span raw-token total still ≥ minTokens (recomputed from the branch);
 *  7. span end within windowTokens of the branch tip (the shallow guard that bounds the
 *     one-time full-price cache-suffix re-read — see README);
 *  8. span does not sit before the compaction cutoff / under the last compaction's summarized
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
		if (rawTokensAfterIndex(branch, lastIndex) > inputs.windowTokens) continue;

		kept.push({ entryIds: [...span.entryIds], tokens });
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
 * Eviction surface for /om:status, folded from the CURRENT branch: how many entries this
 * branch has omitted from projected context and roughly how many verbatim tokens that frees.
 * Branch-local by design: under /tree the numbers roll back with the branch, mirroring how
 * the omissions themselves do.
 */
export function evictionStats(branch: Entry[]): { count: number; tokens: number } {
	const indexes = entryIndexById(branch);
	let count = 0;
	let tokens = 0;
	for (const entry of branch) {
		if (!isContextEditEntry(entry) || entry.replacement !== null) continue;
		count++;
		const targetIndex = indexes.get(entry.targetId);
		if (targetIndex !== undefined) tokens += estimateEntryTokens(branch[targetIndex]);
	}
	return { count, tokens };
}
