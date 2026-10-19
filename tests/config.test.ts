import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULTS, loadConfig } from "../src/config.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-config-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

/** Write a project settings file under the `observational-memory` namespace. */
function writeSettings(namespace: Record<string, unknown>): void {
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "observational-memory": namespace }), "utf-8");
}

describe("loadConfig — eviction keys", () => {
	// Baseline = whatever the global settings file contributes, so the assertions
	// below only depend on what this test writes.
	it("defaults the eviction flag off with the documented thresholds", () => {
		const baseline = loadConfig(cwd);
		expect(baseline.evictObservedEntries).toBe(false);
		expect(baseline.evictionMinTokens).toBe(5_000);
		expect(baseline.evictionWindowTokens).toBe(40_000);
		expect(DEFAULTS.evictObservedEntries).toBe(false);
	});

	it("reads the eviction keys from the settings namespace", () => {
		writeSettings({ evictObservedEntries: true, evictionMinTokens: 8_000, evictionWindowTokens: 30_000 });
		const config = loadConfig(cwd);
		expect(config.evictObservedEntries).toBe(true);
		expect(config.evictionMinTokens).toBe(8_000);
		expect(config.evictionWindowTokens).toBe(30_000);
	});

	it("ignores non-positive or non-integer eviction thresholds (they must not become 0 or negative)", () => {
		const baseline = loadConfig(cwd);
		writeSettings({ evictionMinTokens: 0, evictionWindowTokens: -5 });
		const config = loadConfig(cwd);
		expect(config.evictionMinTokens).toBe(baseline.evictionMinTokens);
		expect(config.evictionWindowTokens).toBe(baseline.evictionWindowTokens);
	});

	it("ignores a non-boolean eviction flag rather than coercing it", () => {
		const baseline = loadConfig(cwd);
		writeSettings({ evictObservedEntries: "true" });
		expect(loadConfig(cwd).evictObservedEntries).toBe(baseline.evictObservedEntries);
	});
});
