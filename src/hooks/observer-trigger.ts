import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assignObservationTimestamps } from "../ids.js";
import {
	entryIndexForId,
	foldLedger,
	latestCoverageMarkerId,
	nowTimestamp,
	rawTokensAfterIndex,
	selectSourceSlice,
	serializeSourceAddressedBranchEntries,
	OM_OBSERVATIONS_RECORDED,
	type Entry,
	type SourceSlice,
} from "../ledger/index.js";
import type { Runtime } from "../runtime.js";
import { buildWorkerArgv, buildWorkerEnv, spawnWorker } from "../spawn/launch.js";
import { readObserverResult, runResultPath } from "../spawn/runs.js";

type TriggerCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, level?: "info" | "warning" | "error") => void };
	sessionManager: { getBranch: () => Entry[] };
};

let runCounter = 0;

function nextRunId(): string {
	runCounter += 1;
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `obs-${stamp}-${process.pid}-${runCounter}`;
}

/** The later (by branch index) of two coverage markers; undefined when neither resolves. */
function laterMarkerId(branch: Entry[], a: string | undefined, b: string | undefined): string | undefined {
	const ia = entryIndexForId(branch, a);
	const ib = entryIndexForId(branch, b);
	if (ia < 0 && ib < 0) return undefined;
	return ia >= ib ? a : b;
}

/** Effective watermark = later of committed ledger coverage and the in-memory dispatch marker. */
function effectiveWatermarkId(runtime: Runtime, branch: Entry[]): string | undefined {
	const committed = latestCoverageMarkerId(branch, OM_OBSERVATIONS_RECORDED);
	const dispatchedResolved = entryIndexForId(branch, runtime.dispatchedCoversUpToId) >= 0 ? runtime.dispatchedCoversUpToId : undefined;
	return laterMarkerId(branch, committed, dispatchedResolved);
}

/**
 * Evaluate the raw-token observer clock and fire as many parallel observers as there is
 * backlog and concurrency for. Pure dispatch: each observer is awaited inside its own async
 * task tracked in `runtime.observersInFlight`, never blocking the event handler.
 */
export function evaluateObserverTriggers(pi: ExtensionAPI, runtime: Runtime, ctx: TriggerCtx): void {
	if (!runtime.enabled || runtime.config.passive) return;

	const cwd = ctx.cwd;
	const hasUI = ctx.hasUI;
	const ui = ctx.ui;
	const sessionManager = ctx.sessionManager;

	while (runtime.observerSlotsAvailable > 0) {
		const branch = sessionManager.getBranch();
		const watermarkId = effectiveWatermarkId(runtime, branch);
		const watermarkIndex = entryIndexForId(branch, watermarkId);
		const remaining = rawTokensAfterIndex(branch, watermarkIndex);
		if (remaining < runtime.config.chunkTokens) return;

		const slice = selectSourceSlice(branch, watermarkId, runtime.config.chunkTokens);
		if (slice.entries.length === 0 || !slice.coversUpToId) return;

		runtime.dispatchedCoversUpToId = slice.coversUpToId;
		runtime.trackObserverTask(dispatchObserver(pi, runtime, { cwd, hasUI, ui, sessionManager }, slice));
	}
}

async function dispatchObserver(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: TriggerCtx,
	slice: SourceSlice,
): Promise<void> {
	const runId = nextRunId();
	const controller = new AbortController();
	runtime.observersInFlight.set(runId, controller);

	const { text: chunkText } = serializeSourceAddressedBranchEntries(slice.entries);
	const coversUpToId = slice.coversUpToId!;
	const lastEntry = slice.entries.at(-1);

	runtime.status.workerStart("observer", runId);
	if (ctx.hasUI) ctx.ui?.notify(`om: observer started (~${slice.tokens.toLocaleString()} tok)`, "info");

	try {
		// The chunk IS the recorded user prompt (passed via `pi -p`), not an ephemeral
		// context-hook injection. This keeps the observer session faithfully inspectable on
		// resume — the whole point of running workers as recorded global sessions (decision 11).
		const userText =
			`Current local time: ${nowTimestamp()}\n\n` +
			"Compress the following conversation chunk into observations by calling record_observations " +
			"one or more times, then reply with a one-sentence confirmation when the chunk is fully covered.\n\n" +
			`NEW CONVERSATION CHUNK:\n${chunkText}`;

		const argv = buildWorkerArgv({
			model: runtime.config.models.observer,
			sessionName: `om-observer-${runId}`,
			kickoffPrompt: userText,
		});
		const env = buildWorkerEnv("observer", { cwd: ctx.cwd, runId });
		const exit = await spawnWorker({ argv, cwd: ctx.cwd, env, signal: controller.signal });
		if (exit.code !== 0) {
			throw new Error(`observer exited with code ${exit.code}${exit.stderr ? `: ${exit.stderr.trim().slice(0, 200)}` : ""}`);
		}

		const result = readObserverResult(runResultPath(ctx.cwd, runId));
		const branch = ctx.sessionManager.getBranch();
		const used = foldLedger(branch).observationsByTimestamp.keys();
		const observations = assignObservationTimestamps(result.observations, {
			used,
			fallbackAnchor: lastEntry?.timestamp,
		});

		if (observations.length > 0) {
			pi.appendEntry(OM_OBSERVATIONS_RECORDED, { observations, coversUpToId });
		}
		runtime.status.workerDone(runId, observations.length);
		if (ctx.hasUI) {
			ctx.ui?.notify(`om: observer +${observations.length} (~${slice.tokens.toLocaleString()} tok)`, "info");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.lastWorkerError = message;
		runtime.status.workerError(runId);
		if (ctx.hasUI) ctx.ui?.notify(`om: observer failed: ${message}`, "error");
	} finally {
		runtime.observersInFlight.delete(runId);
	}
}

export function registerObserverTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const handler = (_event: unknown, ctx: TriggerCtx) => evaluateObserverTriggers(pi, runtime, ctx);
	pi.on("turn_end", handler as never);
	pi.on("agent_start", handler as never);
}
