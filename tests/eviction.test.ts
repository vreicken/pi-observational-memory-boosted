import { describe, expect, it } from "vitest";

import {
	evictableSpansInSlice,
	evictionRecordStats,
	filterEvictableSpans,
	isEditableContextTarget,
	isCompactionImminent,
	spanEvictionDrafts,
	type EvictionFlushInputs,
	type EvictionSpan,
} from "../src/ledger/eviction.js";
import { buildCompactionProjection } from "../src/ledger/projection.js";
import { snapCutoff } from "../src/hooks/compaction-hook.js";
import { estimateEntryTokens } from "../src/tokens.js";
import type { Entry } from "../src/ledger/index.js";
import {
	assistantToolCallMessage,
	branchSummary,
	compactionEntry,
	contextEditEntry,
	observation,
	observationsRecordedEntry,
	rawMessage,
	toolResultMessage,
	type TestEntry,
} from "./fixtures/session.js";

const GIANT = "x".repeat(40_000); // ~10k tokens at ~4 chars/token
const small = "small";
const SMALL_TOKENS = estimateEntryTokens(rawMessage("t", small));

function span(entryIds: string[], branch: TestEntry[], coversUpToId = entryIds[entryIds.length - 1]): EvictionSpan {
	return {
		entryIds,
		coversUpToId,
		tokens: entryIds.reduce(
			(total, id) => total + estimateEntryTokens(branch.find((entry) => entry.id === id) ?? rawMessage(id, "")),
			0,
		),
	};
}

const BASE_INPUTS: EvictionFlushInputs = {
	minTokens: 1,
	tailTokens: 0,
	windowTokens: 100_000,
	contextTokens: null,
	compactAtContextTokens: 1000,
	chunkTokens: 10_000,
};

/** A complete turn: user prompt → assistant tool call → its oversized result. */
function observedTurn(): TestEntry[] {
	return [
		rawMessage("u1", "find the biggest file"), // starts the span
		assistantToolCallMessage("a1", { toolName: "bash" }),
		toolResultMessage("r1", GIANT), // the oversized payload the whole design targets
		rawMessage("u2", small), // terminates the span (next user message)
	];
}

describe("evictableSpansInSlice", () => {
	it("groups an oversized fully-observed turn: user message, assistant call and its result together", () => {
		const branch = observedTurn();
		const slice = branch.slice(0, 3); // the chunk covered [u1, a1, r1]; u2 terminates it
		const spans = evictableSpansInSlice(branch, slice, estimateEntryTokens(rawMessage("t", GIANT)) - 1);

		expect(spans).toHaveLength(1);
		expect(spans[0].entryIds).toEqual(["u1", "a1", "r1"]);
		expect(spans[0].tokens).toBeGreaterThan(SMALL_TOKENS);
	});

	it("keeps nothing for entries before the first user message (their turn began in an earlier slice)", () => {
		const branch = [toolResultMessage("r0", GIANT), ...observedTurn()];
		const slice = branch.slice(1, 4); // [u1, a1, r1]
		const spans = evictableSpansInSlice(branch, slice, estimateEntryTokens(rawMessage("t", GIANT)) - 1);

		expect(spans).toHaveLength(1);
		expect(spans[0].entryIds).toEqual(["u1", "a1", "r1"]);
	});

	it("rejects a trailing span whose turn continues past the watermark (it straddles the chunk)", () => {
		const branch = [
			rawMessage("u1", "find the biggest file"),
			assistantToolCallMessage("a1"),
			toolResultMessage("r1", GIANT),
			assistantToolCallMessage("a2", { text: "still working" }), // turn continues beyond coversUpToId
			rawMessage("u2", small),
		];
		const spans = evictableSpansInSlice(branch, branch.slice(0, 3), 1);
		expect(spans).toEqual([]);
	});

	it("keeps a trailing span that ends exactly at the watermark with a user message right after it", () => {
		const branch = [
			rawMessage("u1", "find the biggest file"),
			assistantToolCallMessage("a1"),
			toolResultMessage("r1", GIANT),
			rawMessage("u2", small),
		];
		const spans = evictableSpansInSlice(branch, branch.slice(0, 3), estimateEntryTokens(rawMessage("t", GIANT)) - 1);
		expect(spans).toEqual([{ entryIds: ["u1", "a1", "r1"], coversUpToId: "r1", tokens: spans[0]?.tokens }]);
	});

	it("discards a slice that never terminated — nothing follows the covered range at all", () => {
		const branch = [
			rawMessage("u1", GIANT),
			assistantToolCallMessage("a1"),
			toolResultMessage("r1", GIANT),
		];
		const spans = evictableSpansInSlice(branch, branch, 1);
		expect(spans).toEqual([]);
	});

	it("emits nothing for a slice without any user message", () => {
		const branch: TestEntry[] = [assistantToolCallMessage("a1"), toolResultMessage("r1", GIANT)];
		const spans = evictableSpansInSlice(branch, branch, 0);
		expect(spans).toEqual([]);
	});

	it("returns nothing when slice ids are not on the branch (confused state → no eviction, never wrong eviction)", () => {
		const spans = evictableSpansInSlice([], observedTurn(), 0);
		expect(spans).toEqual([]);
	});

	// A threshold far above any real span total (u1+a1+r1 is ~10k tokens) must reject it.
	it("drops spans under minTokens at selection time", () => {
		const branch = observedTurn();
		const slice = branch.slice(0, 3);
		const spans = evictableSpansInSlice(branch, slice, 1_000_000);
		expect(spans).toEqual([]);
	});

	it("never groups entries belonging to a slice that has not committed (out-of-order parallel commits)", () => {
		// Chunk A [s1, s2] is still in flight (or failed); chunk B [s3, s4] committed. The branch
		// holds both, so a watermark-only predicate would declare s1..s4 covered. Only the exact
		// committed slice may produce spans.
		const branch = [
			rawMessage("s1", "turn one"),
			toolResultMessage("s2", GIANT),
			rawMessage("s3", "turn two"),
			toolResultMessage("s4", GIANT),
			rawMessage("s5", small),
		];
		const committedSlice = branch.slice(2, 4); // chunk B only
		const spans = evictableSpansInSlice(branch, committedSlice, estimateEntryTokens(rawMessage("t", GIANT)) - 1);

		expect(spans).toHaveLength(1);
		expect(spans[0].entryIds).toEqual(["s3", "s4"]);
	});

	it("terminates a span at a branch summary without including it", () => {
		const slice: TestEntry[] = [
			rawMessage("u1", GIANT),
			branchSummary("bs1", "renamed the module"),
			rawMessage("u2", small),
			rawMessage("u3", small),
		];
		// minTokens just above the u2 span's size so only the GIANT u1 span survives.
		const spans = evictableSpansInSlice(slice, slice, SMALL_TOKENS + 1);

		expect(spans).toEqual([
			{ entryIds: ["u1"], coversUpToId: "u3", tokens: estimateEntryTokens(rawMessage("t", GIANT)) },
		]);
	});
});

describe("isEditableContextTarget", () => {
	it("accepts message user/assistant/toolResult and custom_message, rejects branch_summary and custom", () => {
		expect(isEditableContextTarget(rawMessage("u", "x"))).toBe(true);
		expect(isEditableContextTarget(assistantToolCallMessage("a"))).toBe(true);
		expect(isEditableContextTarget(toolResultMessage("r", GIANT))).toBe(true);
		expect(isEditableContextTarget(branchSummary("b", "s"))).toBe(false);
		expect(isEditableContextTarget({ type: "custom", id: "c" } as Entry)).toBe(false);
	});
});

describe("isCompactionImminent", () => {
	it("fires at-or-inside two chunks of the compaction threshold and stays silent below it", () => {
		const inputs: EvictionFlushInputs = { ...BASE_INPUTS, compactAtContextTokens: 100_000, chunkTokens: 10_000 };
		expect(isCompactionImminent({ ...inputs, contextTokens: 79_999 })).toBe(false);
		expect(isCompactionImminent({ ...inputs, contextTokens: 80_000 })).toBe(true);
		expect(isCompactionImminent({ ...inputs, contextTokens: null })).toBe(false);
	});
});

describe("filterEvictableSpans", () => {
	it("keeps an eligible committed span with branch-accurate tokens", () => {
		// A committed slice needs its committed RECORD on the branch (the coverage the span
		// relies on is the recorded entry, not just the boundary entries).
		const branch: TestEntry[] = [
			...observedTurn(),
			observationsRecordedEntry("om1", { observations: [observation("2026-05-02T09:00:00")], coversUpToId: "r1" }),
		];
		const kept = filterEvictableSpans(branch, [span(["u1", "a1", "r1"], branch)], BASE_INPUTS);

		expect(kept).toHaveLength(1);
		expect(kept[0].entryIds).toEqual(["u1", "a1", "r1"]);
		expect(kept[0].tokens).toBe(span(["u1", "a1", "r1"], branch).tokens);
	});

	it("drops a span whose ids are no longer on the active branch (stale target / tree stray)", () => {
		const activeBranch: TestEntry[] = [rawMessage("fresh", "new turn")];
		const kept = filterEvictableSpans(activeBranch, [span(["u1", "a1", "r1"], observedTurn())], BASE_INPUTS);
		expect(kept).toEqual([]);
	});

	it("drops a span containing a non-editable member rather than emitting one invalid draft", () => {
		const branch: TestEntry[] = [...observedTurn(), branchSummary("bs1", "sum")];
		const kept = filterEvictableSpans(branch, [span(["u1", "a1", "r1", "bs1"], branch)], BASE_INPUTS);
		expect(kept).toEqual([]);
	});

	it("never duplicates an omission: a span member already under a context_edit is skipped", () => {
		const branch = observedTurn();
		// An in-flight parallel chunk committed a span covering [u1, a1]; its drafts landed first.
		const withEdit: TestEntry[] = [...branch, contextEditEntry("ce1", { targetId: "a1", replacement: null })];
		const kept = filterEvictableSpans(withEdit, [span(["u1", "a1", "r1"], branch)], BASE_INPUTS);
		expect(kept).toEqual([]);
	});

	it("also skips a member under a replacement edit (latest-edit-wins layering is not ours to fight)", () => {
		const branch = observedTurn();
		const withEdit: TestEntry[] = [...branch, contextEditEntry("ce1", { targetId: "u1", replacement: { content: "replaced" } })];
		const kept = filterEvictableSpans(withEdit, [span(["u1", "a1", "r1"], branch)], BASE_INPUTS);
		expect(kept).toEqual([]);
	});

	it("rejects an undersized span on the live branch", () => {
		const branch = observedTurn();
		const kept = filterEvictableSpans(
			branch,
			[span(["u1", "a1", "r1"], branch)],
			{ ...BASE_INPUTS, minTokens: 1_000_000 }, // far above any real span total
		);
		expect(kept).toEqual([]);
	});

	it("rejects a stale span whose end is out of the shallow window", () => {
		const branch = observedTurn();
		const kept = filterEvictableSpans(branch, [span(["u1", "a1", "r1"], branch)], {
			...BASE_INPUTS,
			windowTokens: 1,
		});
		expect(kept).toEqual([]);
	});

	it("rejects an un-terminated span (the turn continues past its last member)", () => {
		const branch: TestEntry[] = [
			rawMessage("u1", "find the biggest file"),
			assistantToolCallMessage("a1"),
			toolResultMessage("r1", GIANT),
			// r1's turn never terminated: no user message or branch summary follows.
		];
		const kept = filterEvictableSpans(branch, [span(["u1", "a1", "r1"], branch)], BASE_INPUTS);
		expect(kept).toEqual([]);
	});

	it("rejects a span whose turn is closed by a compaction entry (spanTerminates, not the kept-tail check)", () => {
		const branch: TestEntry[] = [
			...observedTurn(),
			compactionEntry("c1", { firstKeptEntryId: "r1" }),
			rawMessage("u3", "continue the work"),
			rawMessage("u4", small),
		];
		const kept = filterEvictableSpans(branch, [span(["u1", "a1", "r1"], observedTurn())], BASE_INPUTS);
		expect(kept).toEqual([]);
	});

	it("rejects a span whose first member is not a user message", () => {
		const branch = observedTurn();
		const kept = filterEvictableSpans(branch, [span(["a1", "r1"], branch)], BASE_INPUTS);
		expect(kept).toEqual([]);
	});

	// The double-absence defect (QA run 38ca2b3b): the observation pool reaches the model ONLY
	// through the compaction block, so evicting a span whose depth is inside the verbatim-tail
	// window — where the next snap keeps it verbatim instead of folding its covering chunk —
	// leaves it in neither representation.
	it("skips everything when compaction is imminent regardless of span quality", () => {
		const branch = observedTurn();
		const kept = filterEvictableSpans(branch, [span(["u1", "a1", "r1"], branch)], {
			...BASE_INPUTS,
			contextTokens: 99_000,
			compactAtContextTokens: 100_000,
		});
		expect(kept).toEqual([]);
	});

	// The double-absence defect (QA run 38ca2b3b): the observation pool reaches the model ONLY
	// through the compaction block, so evicting a span whose depth is inside the verbatim-tail
	// window — where the next snap keeps the range verbatim instead of folding its covering
	// chunk — leaves it in neither representation.
	it("never evicts a span inside the verbatim-tail window (double absence)", () => {
		// Both spans end inside a 20k-token tail window: the first ~10 tokens from the tip, the
		// second ~10k. Neither may be omitted.
		const branch: TestEntry[] = [
			...observedTurn(),
			rawMessage("u2l", "second turn"),
			toolResultMessage("r2l", GIANT),
			rawMessage("u3l", small),
		];
		const kept = filterEvictableSpans(
			branch,
			[span(["u1", "a1", "r1"], branch), span(["u2l", "r2l"], branch)],
			{ ...BASE_INPUTS, tailTokens: 20_000, windowTokens: 40_000, minTokens: 1000 },
		);
		expect(kept).toEqual([]);
	});

	it("evicts only in the healthy band: outside the tail window, inside the shallow window", () => {
		const branch: TestEntry[] = [
			...observedTurn(),
			rawMessage("u2l", "second turn"),
			toolResultMessage("r2l", GIANT),
			rawMessage("u3l", small),
			observationsRecordedEntry("om1", { observations: [observation("2026-05-02T09:00:00")], coversUpToId: "r1" }),
		];
		// With tailTokens 5k: the first span ends ~10k deep (in band) and is evicted; the second
		// ends ~10 tokens deep (inside the tail window) and stays verbatim.
		const kept = filterEvictableSpans(
			branch,
			[span(["u1", "a1", "r1"], branch), span(["u2l", "r2l"], branch)],
			{ ...BASE_INPUTS, tailTokens: 5_000, windowTokens: 40_000, minTokens: 1000 },
		);
		expect(kept).toHaveLength(1);
		expect(kept[0].entryIds).toEqual(["u1", "a1", "r1"]);
	});

	// The repaired guard measures at the COVERING CHUNK's committed boundary (AC-2, review
	// pass 2). For a multi-span slice the span end lies rootward of `coversUpToId`: the earlier
	// span's end can satisfy a span-end guard while the chunk boundary itself sits inside the
	// tail window — the snap then lands rootward of the covering chunk, excluding its
	// observation from the fold while the omitted span is no longer verbatim either. This test
	// WAS pinned as a characterization of the defect (asserted keep + neither-representation);
	// with the anchor at `coversUpToId` it must assert rejection instead.
	it("rejects a multi-span-slice span whose covering chunk boundary sits inside the tail window", () => {
		const branch: TestEntry[] = [
			rawMessage("u1", "prompt one"),
			toolResultMessage("r1", "x".repeat(40_000)), // chunk A boundary (omA covers r1)
			observationsRecordedEntry("omA", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "r1" }),
			rawMessage("u2", "prompt two"),
			toolResultMessage("r2", "y".repeat(40_000)), // evicted span ends here: depth ~20k, in band
			rawMessage("u3", "prompt three"),
			toolResultMessage("r3", "z".repeat(80_000)), // chunk B boundary (omB covers r3)
			observationsRecordedEntry("omB", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "r3" }),
			rawMessage("u4", "prompt four"),
		];

		// The span [u2, r2] belongs to chunk B, whose boundary (r3) sits ~6 tokens from the tip —
		// inside the 20k tail window. A span-end depth (~20k, passing) is exactly the shape that
		// that used to evade a span-end guard; the covering-boundary anchor must reject it.
		const kept = filterEvictableSpans(branch, [span(["u2", "r2"], branch, "r3")], {
			...BASE_INPUTS,
			tailTokens: 20_000,
			windowTokens: 40_000,
			minTokens: 5_000,
		});
		expect(kept).toEqual([]);

		// Prove the mechanism: WITHOUT the guard the snap would have cut at u2 (chunk A's
		// boundary beats chunk B's) and excluded chunk B's observation from the fold.
		const snap = snapCutoff(branch, "u4", 20_000);
		expect(snap.firstKeptId).toBe("u2");
		const projection = buildCompactionProjection(branch, snap.firstKeptId);
		expect(projection.observations.map((o) => o.content)).toEqual(["Observation 2026-05-02T10:00:01"]);
	});

	it("keeps a multi-span-slice span whose covering chunk boundary IS outside the tail window", () => {
		// Same shape as the rejected case above, but chunk B's boundary (r3) now sits ~21k tokens
		// deep (past the 20k tail window): the covering-boundary anchor passes and the span stays
		// evictable — the anchor measures where the fold actually happens, not the span end.
		const branch: TestEntry[] = [
			rawMessage("u1", "prompt one"),
			toolResultMessage("r1", GIANT),
			observationsRecordedEntry("omA", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "r1" }),
			rawMessage("u2", "prompt two"),
			toolResultMessage("r2", GIANT), // the evicted span ends here (depth ~21,010)
			rawMessage("u3", "prompt three"),
			toolResultMessage("r3", small), // chunk B boundary (omB covers r3), ~21k tokens deep
			observationsRecordedEntry("omB", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "r3" }),
			rawMessage("u4", "prompt four"),
			toolResultMessage("r4", "z".repeat(84_000)), // ~21k of tail filler behind the boundary
			rawMessage("u5", "prompt five"),
		];
		const kept = filterEvictableSpans(branch, [span(["u2", "r2"], branch, "r3")], {
			...BASE_INPUTS,
			tailTokens: 20_000,
			windowTokens: 40_000,
			minTokens: 1000,
		});
		expect(kept).toHaveLength(1);
		expect(kept[0].coversUpToId).toBe("r3");
	});

	it("rejects a span whose covering chunk boundary is not a snap candidate", () => {
		// The chunk ends ON the assistant tool call and its result is the NEXT source entry: the
		// snap never cuts at that boundary (firstKeptAfterBoundary requires a valid cut point),
		// so the fold of its covering chunk cannot be pinned — reject even with the tail depth
		// completely open (tailTokens 0).
		const branch: TestEntry[] = [
			rawMessage("u1", GIANT),
			assistantToolCallMessage("aX", { toolName: "bash" }), // chunk boundary (omA covers aX)
			toolResultMessage("rX", GIANT), // NOT a valid cut point → boundary skipped by the snap
			rawMessage("u2", small),
		];
		const kept = filterEvictableSpans(branch, [span(["u1", "aX"], branch, "aX")], {
			...BASE_INPUTS,
			tailTokens: 0,
		});
		expect(kept).toEqual([]);
	});

	// Coverage was asserted once at commit time — but a /tree rewind can strand the covering
	// chunk's `om.observations.recorded` entry on an ABANDONED branch while every boundary entry
	// survives on the active one. The fold iterates branch entries only, so the observation can
	// never reach the model there, and the observer clock will not re-observe the rewound slice
	// (the in-process dispatch marker still resolves on the branch). So the flush must re-check
	// coverage against the ACTIVE branch (review pass 3) — or the span is evicted and sits in
	// neither representation forever.
	it("rejects a span whose covering committed record is no longer on the active branch (rewind)", () => {
		const rewindBranch: TestEntry[] = [
			rawMessage("u1", "prompt one"), // span starts here
			assistantToolCallMessage("a1"),
			toolResultMessage("r2", GIANT), // the span ends here; u3 terminates the turn
			rawMessage("u3", small),
			toolResultMessage("r3", GIANT), // covering boundary entry (still on this branch)
			rawMessage("u4", small), // valid cut point after the boundary → snap candidate
			toolResultMessage("r4", "z".repeat(84_000)), // ~21k tail filler → depth(r3) ≥ 20k
			rawMessage("u5", small),
		];
		// The masking fact: every member is editable, the covering boundary is a candidate, and
		// its depth clears the band — the only thing missing is the committed record itself.
		const inputs = { ...BASE_INPUTS, tailTokens: 20_000, windowTokens: 100_000, minTokens: 1000 };
		expect(filterEvictableSpans(rewindBranch, [span(["u1", "a1", "r2"], rewindBranch, "r3")], inputs)).toEqual([]);

		// Positive control: the SAME branch with the committed record back on it is evictable —
		// the rewrite must be the discriminator, not some other guard.
		const liveBranch: TestEntry[] = [
			...rewindBranch,
			observationsRecordedEntry("omB", { observations: [observation("2026-05-02T18:00:00")], coversUpToId: "r3" }),
		];
		const kept = filterEvictableSpans(liveBranch, [span(["u1", "a1", "r2"], rewindBranch, "r3")], inputs);
		expect(kept).toHaveLength(1);
		expect(kept[0].coversUpToId).toBe("r3");
	});

	it("treats an invalid (zero-observation) recorded entry as no coverage at all", () => {
		// isObservationsRecordedEntry validates data: a commit with an empty observations array
		// does not count — the observer wrote nothing that could reach the model through it.
		const branch: TestEntry[] = [
			rawMessage("u1", "prompt one"),
			assistantToolCallMessage("a1"),
			toolResultMessage("r2", GIANT),
			rawMessage("u3", small),
			toolResultMessage("r3", GIANT),
			rawMessage("u4", small),
			toolResultMessage("r4", "z".repeat(84_000)),
			rawMessage("u5", small),
			observationsRecordedEntry("omBad", { observations: [], coversUpToId: "r3" }),
		];
		expect(filterEvictableSpans(branch, [span(["u1", "a1", "r2"], branch, "r3")], {
			...BASE_INPUTS,
			tailTokens: 20_000,
			windowTokens: 100_000,
			minTokens: 1000,
		})).toEqual([]);
	});

	// The existing "before the compaction cutoff" test is satisfied by `spanTerminates` (a
	// compaction immediately after the span returns false), so the kept-tail check below it never
	// runs. The check is reachable when the span terminates at a user message and the last
	// compaction sits AFTER that terminator: then the span may already be inside the summarized
	// region. These two tests exercise that check as the only discriminator.
	it("rejects a span already inside the last compaction's summarized region (kept-tail check, not spanTerminates)", () => {
		const branch: TestEntry[] = [
			rawMessage("u1", "prompt one"), // span start
			assistantToolCallMessage("a1"),
			toolResultMessage("r1", GIANT), // span end
			rawMessage("u2", small), // terminates the span -> spanTerminates passes
			compactionEntry("c1", { firstKeptEntryId: "u2" }), // u1..r1 were folded into the summary
			observationsRecordedEntry("om1", { observations: [observation("2026-05-02T10:00:00")], coversUpToId: "r1" }),
		];
		expect(filterEvictableSpans(branch, [span(["u1", "a1", "r1"], branch)], BASE_INPUTS)).toEqual([]);

		// Positive control: the same branch with the compaction keeping the span itself (the span
		// sits in that compaction's kept tail) is evictable — the kept-tail check is the
		// discriminator, not the compaction's mere presence.
		const verbatimBranch: TestEntry[] = [
			...branch.slice(0, 4),
			compactionEntry("c1", { firstKeptEntryId: "u1" }),
			branch[5],
		];
		const kept = filterEvictableSpans(verbatimBranch, [span(["u1", "a1", "r1"], verbatimBranch)], BASE_INPUTS);
		expect(kept).toHaveLength(1);
	});

	// `coveringBoundaryIsSnapCandidate`'s no-qualifying-entry path: the covering boundary is the
	// last source entry on the branch, with only the recorded (non-source) entry behind it. The
	// span itself still terminates — its terminator sits inside the slice — so this is the only
	// guard that rejects it.
	it("rejects a span whose covering boundary has no source entry after it (never a snap candidate)", () => {
		const branch: TestEntry[] = [
			rawMessage("u1", "prompt one"), // span start
			toolResultMessage("r1", GIANT), // span end; u2 terminates it from inside the slice
			rawMessage("u2", small),
			toolResultMessage("r2", small), // covering boundary — last source entry on the branch
			observationsRecordedEntry("om1", { observations: [observation("2026-05-02T10:00:00")], coversUpToId: "r2" }),
		];
		expect(filterEvictableSpans(branch, [span(["u1", "r1"], branch, "r2")], BASE_INPUTS)).toEqual([]);

		// Positive control: a user message after the boundary makes it a real snap candidate.
		const candidateBranch: TestEntry[] = [...branch, rawMessage("u3", small)];
		const kept = filterEvictableSpans(candidateBranch, [span(["u1", "r1"], candidateBranch, "r2")], BASE_INPUTS);
		expect(kept).toHaveLength(1);
		expect(kept[0].coversUpToId).toBe("r2");
	});

	it(": nothing evicts when the band is empty (tail window deeper than the shallow window)", () => {
		const branch = observedTurn();
		const kept = filterEvictableSpans(branch, [span(["u1", "a1", "r1"], branch)], {
			...BASE_INPUTS,
			tailTokens: 50_000,
			windowTokens: 40_000,
		});
		expect(kept).toEqual([]);
	});
});

describe("spanEvictionDrafts", () => {
	it("maps a span to one context_edit draft per member, omitting (replacement null)", () => {
		expect(spanEvictionDrafts({ entryIds: ["u1", "r1"], coversUpToId: "r1", tokens: 5 })).toEqual([
			{ type: "context_edit", targetId: "u1", replacement: null },
			{ type: "context_edit", targetId: "r1", replacement: null },
		]);
	});
});

describe("evictionRecordStats", () => {
	it("sums only recorded (OM-appended) omissions; pi's own recovery omissions never appear here", () => {
		const stats = evictionRecordStats([
			{ entryIds: ["u1", "a1", "r1"], coversUpToId: "r1", tokens: 10_000 },
			{ entryIds: ["u2"], coversUpToId: "u2", tokens: 10 },
		]);
		expect(stats).toEqual({ count: 4, tokens: 10_010 });
	});

	it("returns zeros before any flush", () => {
		expect(evictionRecordStats([])).toEqual({ count: 0, tokens: 0 });
	});
});
