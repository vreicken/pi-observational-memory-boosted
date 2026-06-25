/**
 * TUI observability for observational memory, driven entirely by the in-process orchestrator
 * (subprocess workers are headless). Three surfaces:
 *
 *   - Footer status ("om"): set once at attach, never cleared mid-session.
 *   - Per-worker widgets keyed `<type>-<runId>` so parallel observers STACK rather than
 *     overwrite each other:
 *       ◐ [observer]      working — quarter-circle spinner
 *       ✓ [observer] +4   success — holds, then clears
 *       ✗ [observer]      error — holds, then clears
 *   - Toasts via notify (start/finish/error), gated on hasUI by the caller.
 */

export type WorkerType = "observer" | "consolidator";

interface Theme {
	fg(color: string, text: string): string;
}

export interface StatusUI {
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: string[] | undefined): void;
	theme: Theme;
}

type WorkerState =
	| { kind: "running" }
	| { kind: "done"; delta?: number }
	| { kind: "error" };

const FOOTER_KEY = "om";
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

export interface StatusControllerOptions {
	spinnerIntervalMs?: number;
	settleMs?: number;
}

interface WorkerEntry {
	type: WorkerType;
	state: WorkerState;
	settleTimer?: ReturnType<typeof setTimeout>;
}

export class StatusController {
	private ui: StatusUI | undefined;
	private frame = 0;
	private readonly workers = new Map<string, WorkerEntry>();
	private spinnerTimer: ReturnType<typeof setInterval> | undefined;
	private readonly spinnerIntervalMs: number;
	private readonly settleMs: number;

	constructor(options: StatusControllerOptions = {}) {
		this.spinnerIntervalMs = options.spinnerIntervalMs ?? 120;
		this.settleMs = options.settleMs ?? 5000;
	}

	attach(ui: StatusUI): void {
		this.ui = ui;
		this.ui.setStatus(FOOTER_KEY, this.renderFooter());
	}

	detach(): void {
		this.stopSpinner();
		for (const [key, entry] of this.workers) {
			if (entry.settleTimer) clearTimeout(entry.settleTimer);
			this.ui?.setWidget(this.widgetKey(key), undefined);
		}
		this.workers.clear();
		if (this.ui) this.ui.setStatus(FOOTER_KEY, undefined);
		this.ui = undefined;
	}

	private widgetKey(runId: string): string {
		return `om-${runId}`;
	}

	workerStart(type: WorkerType, runId: string): void {
		if (!this.ui) return;
		const existing = this.workers.get(runId);
		if (existing?.settleTimer) clearTimeout(existing.settleTimer);
		this.workers.set(runId, { type, state: { kind: "running" } });
		this.startSpinner();
		this.renderWorker(runId);
	}

	workerDone(runId: string, delta?: number): void {
		this.settle(runId, { kind: "done", delta });
	}

	workerError(runId: string): void {
		this.settle(runId, { kind: "error" });
	}

	private settle(runId: string, state: WorkerState): void {
		if (!this.ui) return;
		const entry = this.workers.get(runId);
		if (!entry) return;
		if (entry.settleTimer) clearTimeout(entry.settleTimer);
		entry.state = state;
		this.renderWorker(runId);
		entry.settleTimer = setTimeout(() => {
			this.workers.delete(runId);
			this.ui?.setWidget(this.widgetKey(runId), undefined);
			if (!this.hasRunningWorker()) this.stopSpinner();
		}, this.settleMs);
		entry.settleTimer.unref?.();
		if (!this.hasRunningWorker()) this.stopSpinner();
	}

	private hasRunningWorker(): boolean {
		for (const entry of this.workers.values()) {
			if (entry.state.kind === "running") return true;
		}
		return false;
	}

	private startSpinner(): void {
		if (this.spinnerTimer) return;
		this.spinnerTimer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			for (const [runId, entry] of this.workers) {
				if (entry.state.kind === "running") this.renderWorker(runId);
			}
		}, this.spinnerIntervalMs);
		this.spinnerTimer.unref?.();
	}

	private stopSpinner(): void {
		if (!this.spinnerTimer) return;
		clearInterval(this.spinnerTimer);
		this.spinnerTimer = undefined;
	}

	private renderFooter(): string {
		const theme = this.ui?.theme;
		if (!theme) return "om";
		return `${theme.fg("muted", "○")} ${theme.fg("muted", "om")}`;
	}

	private renderWorker(runId: string): void {
		const ui = this.ui;
		const entry = this.workers.get(runId);
		if (!ui || !entry) return;
		const theme = ui.theme;
		const label = theme.fg("muted", `[${entry.type}]`);
		let line: string;
		if (entry.state.kind === "running") {
			line = `${theme.fg("accent", SPINNER_FRAMES[this.frame])} ${theme.fg("accent", `[${entry.type}]`)}`;
		} else if (entry.state.kind === "error") {
			line = `${theme.fg("error", "✗")} ${label}`;
		} else {
			const delta = entry.state.delta && entry.state.delta > 0 ? ` ${theme.fg("success", `+${entry.state.delta}`)}` : "";
			line = `${theme.fg("success", "✓")} ${label}${delta}`;
		}
		ui.setWidget(this.widgetKey(runId), [line]);
	}
}
