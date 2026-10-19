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
import { estimateEntryTokens } from "../src/tokens.js";
import type { Entry } from "../src/ledger/index.js";
import {
	assistantToolCallMessage,
	branchSummary,
	compactionEntry,
	contextEditEntry,
	rawMessage,
	toolResultMessage,
	type TestEntry,
} from "./fixtures/session.js";

const GIANT = "x".repeat(40_000); // ~10k tokens at ~4 chars/token
const small = "small";
const SMALL_TOKENS = estimateEntryTokens(rawMessage("t", small));

function span(entryIds: string[], branch: TestEntry[]): EvictionSpan {
	return {
		entryIds,
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
		expect(spans).toEqual([{ entryIds: ["u1", "a1", "r1"], tokens: spans[0]?.tokens }]);
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

		expect(spans).toEqual([{ entryIds: ["u1"], tokens: estimateEntryTokens(rawMessage("t", GIANT)) }]);
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
		const branch = observedTurn();
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

	it("skips a span that sits before the compaction cutoff (already folded into the summary)", () => {
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
		expect(spanEvictionDrafts({ entryIds: ["u1", "r1"], tokens: 5 })).toEqual([
			{ type: "context_edit", targetId: "u1", replacement: null },
			{ type: "context_edit", targetId: "r1", replacement: null },
		]);
	});
});

describe("evictionRecordStats", () => {
	it("sums only recorded (OM-appended) omissions; pi's own recovery omissions never appear here", () => {
		const stats = evictionRecordStats([
			{ entryIds: ["u1", "a1", "r1"], tokens: 10_000 },
			{ entryIds: ["u2"], tokens: 10 },
		]);
		expect(stats).toEqual({ count: 4, tokens: 10_010 });
	});

	it("returns zeros before any flush", () => {
		expect(evictionRecordStats([])).toEqual({ count: 0, tokens: 0 });
	});
});
