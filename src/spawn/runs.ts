/**
 * File-based IPC between the in-process orchestrator and subprocess workers.
 *
 * A subprocess cannot append to the master's ledger, so it writes its output to a transient
 * result file under `<project>/.memory/.runs/<runId>.json`. The orchestrator reads + validates
 * it after the process exits, then commits to the right tier (observations → ledger).
 *
 * Worker recordings themselves live in pi's GLOBAL session store, not here (decision 11).
 * `.memory/.runs/` clutter is not GC'd in v1 (accepted).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What the observer model emits, before the orchestrator re-derives precise timestamp-ids. */
export type RawObservation = {
	timestamp: string; // "YYYY-MM-DD HH:MM"
	content: string;
};

export type ObserverRunResult = {
	observations: RawObservation[];
};

export function runsDir(cwd: string): string {
	return join(cwd, ".memory", ".runs");
}

export function runResultPath(cwd: string, runId: string): string {
	return join(runsDir(cwd), `${runId}.result.json`);
}

/** Atomic write (temp + rename) so a reader never sees a half-written file. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

function isRawObservation(value: unknown): value is RawObservation {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.timestamp === "string" && typeof v.content === "string" && v.content.trim().length > 0;
}

/** Parse + validate an observer result file. Throws on malformed input. */
export function readObserverResult(path: string): ObserverRunResult {
	const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object" || !Array.isArray((raw as { observations?: unknown }).observations)) {
		throw new Error("observer result missing observations array");
	}
	const observations = (raw as { observations: unknown[] }).observations.filter(isRawObservation);
	return { observations };
}

export function writeObserverResult(path: string, result: ObserverRunResult): void {
	atomicWrite(path, JSON.stringify(result));
}

/** What the consolidator reports: the observation timestamp-ids it absorbed into topic files. */
export type ConsolidatorRunResult = {
	promotedTimestamps: string[];
};

/** Parse + validate a consolidator result file. Throws on malformed input. */
export function readConsolidatorResult(path: string): ConsolidatorRunResult {
	const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!raw || typeof raw !== "object" || !Array.isArray((raw as { promotedTimestamps?: unknown }).promotedTimestamps)) {
		throw new Error("consolidator result missing promotedTimestamps array");
	}
	const promotedTimestamps = (raw as { promotedTimestamps: unknown[] }).promotedTimestamps.filter(
		(t): t is string => typeof t === "string" && t.length > 0,
	);
	return { promotedTimestamps };
}

export function writeConsolidatorResult(path: string, result: ConsolidatorRunResult): void {
	atomicWrite(path, JSON.stringify(result));
}
