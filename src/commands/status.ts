import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	confirmedEvictionSpans,
	evictionRecordStats,
	foldLedger,
	omissionTargetIds,
	poolTokens,
	rawTokensSinceObservationCoverage,
	sumSessionCost,
	type Entry,
} from "../ledger/index.js";
import { listTopics, readJourney } from "../memory/paths.js";
import { estimateStringTokens } from "../tokens.js";
import type { Runtime } from "../runtime.js";
import { renderTimeline } from "../ui/timeline.js";

export function registerStatusCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:status", {
		description: "Show observational-memory status (workers, buffer, clocks)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!runtime.enabled) {
				ctx.ui.notify("om is off (use /om on to enable)", "info");
				return;
			}
			runtime.ensureConfig(ctx.cwd);
			const branch = ctx.sessionManager.getBranch() as Entry[];
			const folded = foldLedger(branch);
			const sinceObservation = rawTokensSinceObservationCoverage(branch);
			const contextTokens = ctx.getContextUsage?.()?.tokens ?? null;
			const pool = poolTokens(folded.activeObservations);
			const topicCount = listTopics(runtime.memoryRoot).length;
			const journey = readJourney(runtime.memoryRoot);
			const { costUsd, runs } = sumSessionCost(ctx.sessionManager.getEntries() as Entry[]);
			// Counts ONLY omissions OM appended this process AND that actually landed on the branch
			// (confirmed against context_edit omissions keyed to recorded target ids) — pi's own
			// recovery omissions are indistinguishable on the branch and are never counted, and a
			// dispatch pi dropped wholesale (failed validation) is de-credited rather than reported.
			const confirmed = confirmedEvictionSpans(runtime.evictionRecords, omissionTargetIds(branch));
			const evictions = evictionRecordStats(confirmed);

			const lines = [
				`om status`,
				`  observers in flight: ${runtime.observersInFlight.size} / ${runtime.config.observerConcurrency}`,
				`  active observations: ${folded.activeObservations.length}`,
				`  next observer: ${sinceObservation.toLocaleString()} / ${runtime.config.chunkTokens.toLocaleString()} tok`,
				`  pool: ${pool.toLocaleString()} tok (target ${runtime.config.poolTargetTokens.toLocaleString()}, consolidate at ${runtime.config.consolidateAtPoolTokens.toLocaleString()})`,
				`  evictions: ${evictions.count.toLocaleString()} entr${evictions.count === 1 ? "y" : "ies"} omitted (~${evictions.tokens.toLocaleString()} tok projected-context freed)`,
				`  consolidator: ${runtime.consolidatorInFlight ? "running" : "idle"}`,
				`  last compaction wait: ${runtime.lastCompactionObserverWait ?? "n/a"}`,
				`  topic files: ${topicCount}`,
				`  journey: ${journey ? `~${estimateStringTokens(journey).toLocaleString()} / ${runtime.config.journeyTargetTokens.toLocaleString()} tok` : "none yet"}`,
				`  context: ${contextTokens != null ? contextTokens.toLocaleString() : "?"} / ${runtime.config.compactAtContextTokens.toLocaleString()} tok`,
				`  session cost: $${costUsd.toFixed(4)} (${runs} run${runs === 1 ? "" : "s"})`,
				runtime.lastWorkerError ? `  last error: ${runtime.lastWorkerError}` : `  last error: none`,
				"",
				renderTimeline(branch, runtime.config),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
