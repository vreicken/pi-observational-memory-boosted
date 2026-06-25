import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	entryIndexById,
	isObservationsRecordedEntry,
	isSourceEntry,
	rawTokensAfterIndex,
	renderSummary,
	type Entry,
} from "../ledger/index.js";

/** A message entry that is a tool result must stay with its tool call — never a cut point. */
function isValidCutPoint(entry: Entry): boolean {
	if (entry.type === "custom_message" || entry.type === "branch_summary") return true;
	if (entry.type === "message") {
		const role = (entry.message as { role?: string } | undefined)?.role;
		return role === "user" || role === "assistant";
	}
	return false;
}

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
 * `tailTokens`. Falls back to pi's proposal when no boundary qualifies.
 */
export function snapFirstKeptEntryId(branch: Entry[], proposedFirstKeptId: string, tailTokens: number): string {
	const boundaries = chunkBoundaryIndices(branch);
	let bestId: string | undefined;
	let bestDelta = Number.POSITIVE_INFINITY;

	for (const boundaryIndex of boundaries) {
		const firstKept = firstKeptAfterBoundary(branch, boundaryIndex);
		if (!firstKept) continue;
		const tail = rawTokensAfterIndex(branch, boundaryIndex);
		const delta = Math.abs(tail - tailTokens);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestId = firstKept.id;
		}
	}

	return bestId ?? proposedFirstKeptId;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		if (!runtime.enabled || runtime.config.passive) return undefined;

		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) ctx.ui.notify("om: another compaction is already in progress; cancelling duplicate", "warning");
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const branch = event.branchEntries as Entry[];
			const { firstKeptEntryId, tokensBefore } = event.preparation;
			const snapped = snapFirstKeptEntryId(branch, firstKeptEntryId, runtime.config.tailTokens);
			const projection = buildCompactionProjection(branch, snapped);
			// Phase A: map section is a no-op placeholder until the consolidator ships (Phase B).
			const summary = renderSummary(undefined, projection.observations);

			return {
				compaction: {
					summary,
					firstKeptEntryId: snapped,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
