import { describe, expect, it } from "vitest";

import { buildCompactionProjection, renderSummary } from "../src/ledger/index.js";
import { snapFirstKeptEntryId } from "../src/hooks/compaction-hook.js";
import {
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

		const summary = renderSummary(undefined, projection.observations);
		expect(summary).toContain("2026-05-02T10:00:01  early");
		expect(summary).toContain("2026-05-02T10:05:00  late");
	});
});
