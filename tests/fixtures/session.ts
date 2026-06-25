export type TestEntry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
	fromId?: string;
};

export type TestObservation = {
	timestamp: string;
	content: string;
	tokenCount: number;
};

export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
export const OM_FOLDED = "om.folded";

const DEFAULT_TIMESTAMP = "2026-05-02T10:00:00.000Z";

export function rawMessage(id: string, text: string, overrides: Partial<TestEntry> = {}): TestEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		message: { role: "user", content: [{ type: "text", text }] },
		...overrides,
	};
}

/** A tool-result message entry — a source entry that is NOT a valid compaction cut point. */
export function toolResultMessage(id: string, text: string, overrides: Partial<TestEntry> = {}): TestEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] },
		...overrides,
	};
}

export function customMessage(id: string, content: unknown, overrides: Partial<TestEntry> = {}): TestEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		content,
		...overrides,
	};
}

export function textCustomMessage(id: string, text: string, overrides: Partial<TestEntry> = {}): TestEntry {
	return customMessage(id, text, overrides);
}

export function branchSummary(id: string, summary: string, overrides: Partial<TestEntry> = {}): TestEntry {
	return {
		type: "branch_summary",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		summary,
		...overrides,
	};
}

export function compactionEntry(
	id: string,
	args: { firstKeptEntryId?: string; details?: unknown; summary?: string } = {},
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		firstKeptEntryId: args.firstKeptEntryId,
		summary: args.summary ?? "compacted memory",
		details: args.details,
		...overrides,
	};
}

export function memoryDetails(args: { observations?: TestObservation[] } = {}): unknown {
	return {
		type: OM_FOLDED,
		version: 1,
		observations: args.observations ?? [],
	};
}

export function observation(timestamp: string, overrides: Partial<TestObservation> = {}): TestObservation {
	return {
		timestamp,
		content: `Observation ${timestamp}`,
		tokenCount: 10,
		...overrides,
	};
}

export function observationsRecordedEntry(
	id: string,
	args: { observations: TestObservation[]; coversUpToId: string },
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: OM_OBSERVATIONS_RECORDED,
		data: args,
		...overrides,
	};
}

export function observationsDroppedEntry(
	id: string,
	args: { observationTimestamps: string[]; coversUpToId: string },
	overrides: Partial<TestEntry> = {},
): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType: OM_OBSERVATIONS_DROPPED,
		data: args,
		...overrides,
	};
}

export function unknownCustomEntry(id: string, customType: string, data: unknown = {}): TestEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: DEFAULT_TIMESTAMP,
		customType,
		data,
	};
}
