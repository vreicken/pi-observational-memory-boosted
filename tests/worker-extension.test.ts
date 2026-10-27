import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import omWorker from "../agent/index.js";
import { trackWorkerCost } from "../agent/cost.js";
import { CONSOLIDATOR_SYSTEM } from "../agent/consolidator/prompt.js";
import { OBSERVER_SYSTEM } from "../agent/observer/prompt.js";
import { readWorkerCost } from "../src/spawn/runs.js";

/**
 * The worker extension (`agent/index.ts`) is loaded into a subprocess `pi` via `-e` and never
 * imported by the master, so nothing in the suite exercised its role dispatch before this file:
 * it was at 0% coverage while every worker-side behaviour below (which tools a role gets, which
 * system prompt replaces pi's, which env var is mandatory) was proven only in a live run.
 */

type Handler = (event: unknown, ctx?: unknown) => unknown;
type ToolDef = { name: string };

/** The env vars the worker extension reads; restored after every case. */
const WORKER_ENV = ["OM_WORKER", "OM_RESULT_PATH", "OM_MEMORY_DIR", "OM_COST_PATH"] as const;

type Harness = {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	tools: Map<string, ToolDef>;
};

function makePi(): Harness {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDef>();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (def: ToolDef) => {
			tools.set(def.name, def);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, tools };
}

function handlerFor(harness: Harness, event: string): Handler {
	const list = harness.handlers.get(event) ?? [];
	if (list.length === 0) throw new Error(`no handler registered for ${event}`);
	return list[0];
}

describe("worker extension role dispatch", () => {
	const roots: string[] = [];
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of WORKER_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of WORKER_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		for (const root of roots) rmSync(root, { recursive: true, force: true });
		roots.length = 0;
	});

	function tempRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "om-worker-"));
		roots.push(root);
		return root;
	}

	it("boots the observer role: scoped tool, role prompt, shutdown on agent_end", async () => {
		const harness = makePi();
		process.env.OM_WORKER = "observer";
		process.env.OM_RESULT_PATH = join(tempRoot(), "r.result.json");

		omWorker(harness.pi);

		expect([...harness.tools.keys()]).toEqual(["record_observations"]);
		// No result file read happens here: registration seeds an empty one for the tool to grow.
		expect(readWorkerCost(process.env.OM_RESULT_PATH)).toBeUndefined();

		const start = await handlerFor(harness, "before_agent_start")({}, {});
		expect(start).toEqual({ systemPrompt: OBSERVER_SYSTEM });

		let shutdowns = 0;
		await handlerFor(harness, "agent_end")({}, { shutdown: () => (shutdowns += 1) });
		expect(shutdowns).toBe(1);
	});

	it("boots the consolidator role against the .memory sandbox", async () => {
		const harness = makePi();
		process.env.OM_WORKER = "consolidator";
		process.env.OM_MEMORY_DIR = join(tempRoot(), ".memory", "sess-1");

		omWorker(harness.pi);

		// No terminal/report tool: the consolidator's output is its .memory/ edits.
		expect([...harness.tools.keys()].sort()).toEqual(["edit", "grep", "ls", "read", "write"]);

		const start = await handlerFor(harness, "before_agent_start")({}, {});
		expect(start).toEqual({ systemPrompt: CONSOLIDATOR_SYSTEM });

		let shutdowns = 0;
		await handlerFor(harness, "agent_end")({}, { shutdown: () => (shutdowns += 1) });
		expect(shutdowns).toBe(1);
	});

	it("refuses an observer launch with no result path", () => {
		process.env.OM_WORKER = "observer";
		expect(() => omWorker(makePi().pi)).toThrow("OM_RESULT_PATH not set for observer worker");
	});

	it("refuses a consolidator launch with no memory dir", () => {
		process.env.OM_WORKER = "consolidator";
		expect(() => omWorker(makePi().pi)).toThrow("OM_MEMORY_DIR not set for consolidator worker");
	});

	it("registers nothing for an unknown role (the master owns role selection)", () => {
		const harness = makePi();
		process.env.OM_WORKER = "mystery";
		omWorker(harness.pi);
		expect(harness.handlers.size).toBe(0);
		expect(harness.tools.size).toBe(0);
	});
});

describe("trackWorkerCost", () => {
	const roots: string[] = [];
	let savedCostPath: string | undefined;

	beforeEach(() => {
		savedCostPath = process.env.OM_COST_PATH;
		delete process.env.OM_COST_PATH;
	});

	afterEach(() => {
		if (savedCostPath === undefined) delete process.env.OM_COST_PATH;
		else process.env.OM_COST_PATH = savedCostPath;
		for (const root of roots) rmSync(root, { recursive: true, force: true });
		roots.length = 0;
	});

	function tempRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "om-cost-"));
		roots.push(root);
		return root;
	}

	it("is a no-op when the orchestrator set no cost path (standalone worker run)", () => {
		const harness = makePi();
		trackWorkerCost(harness.pi);
		expect(harness.handlers.size).toBe(0);
	});

	it("accumulates assistant-message cost and hands it back on agent_end", async () => {
		const harness = makePi();
		const costPath = join(tempRoot(), "r.cost.json");
		process.env.OM_COST_PATH = costPath;
		trackWorkerCost(harness.pi);

		const messageEnd = handlerFor(harness, "message_end");
		await messageEnd({ message: { role: "assistant", usage: { cost: { total: 0.5 } } } });
		await messageEnd({ message: { role: "assistant", usage: { cost: { total: 0.25 } } } });
		// Non-assistant messages and unusable totals contribute nothing.
		await messageEnd({ message: { role: "user", usage: { cost: { total: 9 } } } });
		await messageEnd({ message: { role: "assistant", usage: { cost: { total: "free" } } } });
		await messageEnd({ message: { role: "assistant" } });
		await messageEnd({});

		await handlerFor(harness, "agent_end")({}, {});
		expect(readWorkerCost(costPath)).toEqual({ costUsd: 0.75 });
	});

	it("swallows a cost-write failure so telemetry never crashes the worker", async () => {
		const harness = makePi();
		const blocked = join(tempRoot(), "blocked");
		writeFileSync(blocked, "not a directory");
		process.env.OM_COST_PATH = join(blocked, "r.cost.json");
		trackWorkerCost(harness.pi);

		await handlerFor(harness, "message_end")({ message: { role: "assistant", usage: { cost: { total: 1 } } } });
		// The path's parent is a regular file, so the atomic write cannot create it.
		await expect(handlerFor(harness, "agent_end")({}, {})).resolves.toBeUndefined();
		expect(readFileSync(blocked, "utf-8")).toBe("not a directory");
	});
});
