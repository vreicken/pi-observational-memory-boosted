/**
 * Ledger custom-type vocabulary for observational memory (v1, minimal schema).
 *
 * Trimmed from OM V3: the reflections tier, the `relevance` field, `sourceEntryIds`,
 * content-hash ids, and the usage tier are all gone. An observation is the minimal
 * `{ timestamp, content, tokenCount }`; the precise event-`timestamp` doubles as the id
 * (the orchestrator guarantees uniqueness at commit — see ../ids.ts).
 */

/** Observer output committed by the orchestrator; the buffer tier. */
export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
/** Promotion tombstones written by the orchestrator after a consolidator run (Phase B). */
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
/** Compaction details type stamped into the compaction entry's `details`. */
export const OM_FOLDED = "om.folded";
/** Per-session on/off gate state (default OFF). See src/index.ts. */
export const OM_ENABLED = "om.enabled";

export type Entry = {
	type: string;
	id: string;
	timestamp?: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	fromId?: string;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
};

/**
 * Minimal observation unit (decision 9 / L5).
 * - `timestamp`: the orchestrator-assigned precise, unique id-timestamp
 *   ("YYYY-MM-DDTHH:MM:SS" with an optional ".NN" disambiguator). Doubles as the id.
 * - `content`: single-line plain prose.
 * - `tokenCount`: computed in code (never by the model).
 */
export type Observation = {
	timestamp: string;
	content: string;
	tokenCount: number;
};

export type ObservationsRecordedEntryData = {
	observations: Observation[];
	coversUpToId: string;
};

export type ObservationsDroppedEntryData = {
	observationTimestamps: string[];
	coversUpToId: string;
};

/** Stamped into the compaction entry's `details` so a future visible projection can read it back. */
export type MemoryDetails = {
	type: typeof OM_FOLDED;
	version: 1;
	observations: Observation[];
};

export type MemoryCustomType = typeof OM_OBSERVATIONS_RECORDED | typeof OM_OBSERVATIONS_DROPPED;

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

export function isObservation(value: unknown): value is Observation {
	if (!isPlainRecord(value)) return false;
	return (
		isNonEmptyString(value.timestamp) &&
		isNonEmptyString(value.content) &&
		!/\r|\n/.test(value.content) &&
		isTokenCount(value.tokenCount)
	);
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
	if (!isPlainRecord(value)) return false;
	return (
		Array.isArray(value.observations) &&
		value.observations.length > 0 &&
		value.observations.every(isObservation) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
	if (!isPlainRecord(value)) return false;
	return isNonEmptyStringArray(value.observationTimestamps) && isNonEmptyString(value.coversUpToId);
}

export function isMemoryDetails(value: unknown): value is MemoryDetails {
	if (!isPlainRecord(value)) return false;
	return (
		value.type === OM_FOLDED &&
		value.version === 1 &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation)
	);
}

export function isObservationsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_RECORDED;
	data: ObservationsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}

export function isObservationsDroppedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_DROPPED;
	data: ObservationsDroppedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data);
}

export function buildObservationsRecordedData(
	observations: Observation[],
	coversUpToId: string,
): ObservationsRecordedEntryData | undefined {
	if (observations.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observations, coversUpToId };
}

export function buildObservationsDroppedData(
	observationTimestamps: string[],
	coversUpToId: string,
): ObservationsDroppedEntryData | undefined {
	if (observationTimestamps.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observationTimestamps, coversUpToId };
}
