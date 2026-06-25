import { type Config, DEFAULTS, loadConfig } from "./config.js";
import { StatusController } from "./ui/status-controller.js";

/**
 * In-process orchestrator state. Event-driven only — no daemon/timer beyond the status
 * spinner. Ephemeral: rebuilt on session_start, cleared on session_shutdown.
 */
export class Runtime {
	config: Config = { ...DEFAULTS };
	configLoaded = false;

	/** The per-session on/off gate (default OFF). Outermost guard in every handler. */
	enabled = false;

	/** In-flight observer subprocesses, keyed by runId, with their abort controllers. */
	readonly observersInFlight = new Map<string, AbortController>();

	/** In-flight observer async tasks, so compaction can wait for settled memory state (design R5). */
	readonly observerTasks = new Set<Promise<void>>();

	/**
	 * coversUpToId of the most-recent chunk DISPATCHED (committed or still in flight). Combined
	 * with the committed ledger watermark, this is the effective observation watermark: it keeps
	 * parallel observers from re-selecting the same slice and lets zero-observation chunks (which
	 * commit no ledger entry) still advance the clock. In-memory only — lost on resume (harmless;
	 * worst case a chunk is re-observed).
	 */
	dispatchedCoversUpToId: string | undefined;

	/** Guards so compaction trigger + hook never re-enter. */
	compactInFlight = false;
	compactHookInFlight = false;

	/** Last worker error message, surfaced by /om:status. */
	lastWorkerError: string | undefined;

	readonly status = new StatusController();

	ensureConfig(cwd: string): void {
		if (this.configLoaded) return;
		this.config = loadConfig(cwd);
		this.configLoaded = true;
	}

	/** Abort and forget all in-flight observers (session shutdown / disable). */
	abortAllWorkers(): void {
		for (const controller of this.observersInFlight.values()) {
			controller.abort();
		}
		this.observersInFlight.clear();
	}

	/** Track an observer task for the lifetime of its async run. */
	trackObserverTask(task: Promise<void>): void {
		this.observerTasks.add(task);
		void task.finally(() => this.observerTasks.delete(task));
	}

	/** Resolve once no observer tasks are in flight (compaction blocks on this). */
	async whenObserversIdle(): Promise<void> {
		while (this.observerTasks.size > 0) {
			await Promise.allSettled([...this.observerTasks]);
		}
	}

	get observerSlotsAvailable(): number {
		return Math.max(0, this.config.observerConcurrency - this.observersInFlight.size);
	}
}
