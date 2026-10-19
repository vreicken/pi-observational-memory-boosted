import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULTS, loadConfig, readEnvConfig } from "../src/config.js";

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

describe("loadConfig — settings normalization", () => {
	// `normalizeSettingsConfig` falls back to DEFAULTS, not to the global settings layer, so the
	// assertions below reference DEFAULTS rather than whatever a machine's global file contributes.
	it("normalizes model entries field by field instead of replacing the whole model", () => {
		writeSettings({ models: { observer: { provider: "custom-provider", id: "custom-id", thinking: "bogus" } } });
		const config = loadConfig(cwd);
		expect(config.models.observer.provider).toBe("custom-provider");
		expect(config.models.observer.id).toBe("custom-id");
		// An unrecognised thinking level is ignored, not coerced — it falls back to the base.
		expect(config.models.observer.thinking).toBe(DEFAULTS.models.observer.thinking);
	});

	it("treats an empty string as absent and keeps a valid thinking level", () => {
		writeSettings({ models: { observer: { provider: "", id: "custom-id", thinking: "low" } } });
		const config = loadConfig(cwd);
		expect(config.models.observer.provider).toBe(DEFAULTS.models.observer.provider);
		expect(config.models.observer.id).toBe("custom-id");
		expect(config.models.observer.thinking).toBe("low");
	});

	it("keeps the base model wholesale when an entry is not a record", () => {
		writeSettings({ models: { observer: "not a record", consolidator: null } });
		const config = loadConfig(cwd);
		expect(config.models.observer).toEqual(DEFAULTS.models.observer);
		expect(config.models.consolidator).toEqual(DEFAULTS.models.consolidator);
	});

	it("accepts a boolean flag and ignores a non-boolean one (same discipline as the eviction flag)", () => {
		const baseline = loadConfig(cwd);
		writeSettings({ resumeAfterMidRunCompaction: false, debugLog: "true" });
		const config = loadConfig(cwd);
		expect(config.resumeAfterMidRunCompaction).toBe(false);
		expect(config.debugLog).toBe(baseline.debugLog);
	});

	it("reads the passive flag from the environment, in both directions", () => {
		expect(readEnvConfig({ PI_OM_PASSIVE: " ON " })).toEqual({ passive: true });
		expect(readEnvConfig({ PI_OM_PASSIVE: "False" })).toEqual({ passive: false });
		// An unrecognised value is not a passive=true coercion — it contributes nothing.
		expect(readEnvConfig({ PI_OM_PASSIVE: "maybe" })).toEqual({});
		expect(readEnvConfig({})).toEqual({});
	});

	it("survives a malformed settings file rather than throwing", () => {
		writeFileSync(join(cwd, ".pi", "settings.json"), "{ not json", "utf-8");
		const config = loadConfig(cwd);
		expect(config.evictObservedEntries).toBe(DEFAULTS.evictObservedEntries);
	});
});

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
