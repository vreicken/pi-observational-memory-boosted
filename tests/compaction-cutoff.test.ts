import { describe, expect, it } from "vitest";

import { buildCompactionProjection, isSourceEntry, renderSummary } from "../src/ledger/index.js";
import { canSkipObserverWait, snapCutoff, snapFirstKeptEntryId } from "../src/hooks/compaction-hook.js";
import {
	contextEditEntry,
	observation,
	observationsRecordedEntry,
	rawMessage,
	toolResultMessage,
} from "./fixtures/session.js";

// 40 chars ⇒ 10 estimated tokens per source message.
const body = "x".repeat(40);

describe("snapFirstKeptEntryId", () => {
	it("snaps to the chunk boundary whose tail is closest to tailTokens", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-4" }),
			rawMessage("raw-5", body),
			rawMessage("raw-6", body),
		];

		// Boundaries: raw-2 (tail 40), raw-4 (tail 20). tailTokens 25 → raw-4 boundary → keep raw-5.
		expect(snapFirstKeptEntryId(branch, "raw-6", 25)).toBe("raw-5");
		// Larger tailTokens favors the earlier boundary.
		expect(snapFirstKeptEntryId(branch, "raw-6", 40)).toBe("raw-3");
	});

	it("skips a boundary whose next entry is not a valid cut point (tool result)", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			toolResultMessage("tr-1", body), // would-be firstKept after raw-2 → invalid
			rawMessage("raw-3", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-3" }),
			rawMessage("raw-4", body),
		];

		// raw-2 boundary disqualified (next entry tr-1 is a tool result); raw-3 boundary keeps raw-4.
		expect(snapFirstKeptEntryId(branch, "raw-4", 5)).toBe("raw-4");
	});

	it("falls back to pi's proposed firstKeptEntryId when no boundary qualifies", () => {
		const branch = [rawMessage("raw-1", body), rawMessage("raw-2", body)];
		expect(snapFirstKeptEntryId(branch, "raw-2", 5)).toBe("raw-2");
	});

	it("is unaffected by a context_edit omission on the branch (non-source, skips cleanly)", () => {
		const plain = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-4" }),
			rawMessage("raw-5", body),
		];
		// The same branch with an omission appended (raw-1 was evicted by the flusher).
		const evicted = [...plain, contextEditEntry("ce-1", { targetId: "raw-1", replacement: null })];

		// A context_edit is not a source entry, so it is never a boundary or a cut point.
		expect(isSourceEntry(contextEditEntry("ce-1", { targetId: "raw-1", replacement: null }))).toBe(false);
		// Same snap with or without the omission: the edit sits after every boundary and changes
		// no boundary's tail, so the snap is identical.
		expect(snapFirstKeptEntryId(evicted, "raw-5", 10)).toBe(snapFirstKeptEntryId(plain, "raw-5", 10));
	});
});

describe("canSkipObserverWait (R5 fast path)", () => {
	// Two committed chunks; cutoff snaps to raw-4 boundary (keep raw-5). Tail after raw-4 = 10.
	const branch = [
		rawMessage("raw-1", body),
		rawMessage("raw-2", body),
		observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01")], coversUpToId: "raw-2" }),
		rawMessage("raw-3", body),
		rawMessage("raw-4", body),
		observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00")], coversUpToId: "raw-4" }),
		rawMessage("raw-5", body),
		rawMessage("raw-6", body),
	];
	const snap = snapCutoff(branch, "raw-6", 20); // firstKeptId raw-5, tail 20 (raw-5 + raw-6)

	it("skips when there are no in-flight observers and the tail is at/under target", () => {
		expect(snap.firstKeptId).toBe("raw-5");
		expect(snap.tail).toBe(20);
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [])).toBe(true);
	});

	it("skips when every in-flight observer covers a chunk in the verbatim tail", () => {
		// Observer working raw-6 (after the raw-5 cutoff) → excluded from the projection anyway.
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "raw-6" }])).toBe(true);
	});

	it("waits when an in-flight observer covers a chunk at/before the cutoff", () => {
		// A slow observer still on raw-2 (before the raw-5 cutoff) would enter the projection.
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "raw-2" }])).toBe(false);
	});

	it("waits when the in-flight observer's coversUpToId does not resolve in the branch", () => {
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 20, [{ coversUpToId: "ghost" }])).toBe(false);
	});

	it("waits when the snapped tail exceeds tailTokens (snap could still move)", () => {
		// tailTokens 5 < actual tail 10 → a just-committed tail boundary could become a better snap.
		expect(canSkipObserverWait(branch, snap.firstKeptId, snap.tail, 5, [])).toBe(false);
	});

	it("waits when snap fell back to pi's proposal (no qualifying boundary)", () => {
		const bare = [rawMessage("raw-1", body), rawMessage("raw-2", body)];
		const fallback = snapCutoff(bare, "raw-2", 5);
		expect(fallback.tail).toBeUndefined();
		expect(canSkipObserverWait(bare, fallback.firstKeptId, fallback.tail, 5, [])).toBe(false);
	});
});

describe("cutoff ↔ projection integration (no double representation)", () => {
	it("renders exactly the observations whose source precedes the snapped cutoff", () => {
		const branch = [
			rawMessage("raw-1", body),
			rawMessage("raw-2", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01", { content: "early" })], coversUpToId: "raw-2" }),
			rawMessage("raw-3", body),
			rawMessage("raw-4", body),
			observationsRecordedEntry("om-2", { observations: [observation("2026-05-02T10:05:00", { content: "late" })], coversUpToId: "raw-4" }),
			rawMessage("raw-5", body),
		];

		const snapped = snapFirstKeptEntryId(branch, "raw-5", 10); // tail after raw-4 = 10 → keep raw-5
		expect(snapped).toBe("raw-5");

		const projection = buildCompactionProjection(branch, snapped);
		// Both chunks precede the cutoff (raw-5); both render, nothing in the verbatim tail.
		expect(projection.observations.map((o) => o.content)).toEqual(["early", "late"]);

		const summary = renderSummary(undefined, undefined, projection.observations);
		expect(summary).toContain("2026-05-02T10:00:01  early");
		expect(summary).toContain("2026-05-02T10:05:00  late");
	});

	it("folds only ledger custom entries: an omitted source contributes nothing to the block", () => {
		const branch = [
			rawMessage("raw-1", body),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:01", { content: "early" })], coversUpToId: "raw-1" }),
			rawMessage("raw-2", body),
			contextEditEntry("ce-1", { targetId: "raw-1", replacement: null }),
		];

		const projection = buildCompactionProjection(branch, "raw-2");
		// The block is the MemoryDetails blob only — no raw source entry, omitted or otherwise,
		// can enter it.
		expect(projection.details).toEqual({ type: "om.folded", version: 1, observations: projection.observations });
		expect(projection.observations.map((o) => o.content)).toEqual(["early"]);
	});
});
