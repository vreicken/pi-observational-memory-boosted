import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerConsolidatorTools } from "../agent/consolidator/tools.js";
import { buildWorkerEnv } from "../src/spawn/launch.js";
import { readConsolidatorResult, runResultPath, writeConsolidatorResult } from "../src/spawn/runs.js";

describe("buildWorkerEnv(consolidator)", () => {
	it("sets role, run id, result path, and the .memory sandbox root", () => {
		const env = buildWorkerEnv("consolidator", { cwd: "/proj", runId: "c1" });
		expect(env.OM_WORKER).toBe("consolidator");
		expect(env.OM_RUN_ID).toBe("c1");
		expect(env.OM_RESULT_PATH).toBe(runResultPath("/proj", "c1"));
		expect(env.OM_MEMORY_DIR).toBe("/proj/.memory");
	});
});

describe("consolidator result IPC", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-cons-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips promotedTimestamps, dropping non-strings", () => {
		const path = join(dir, "c.result.json");
		writeFileSync(path, JSON.stringify({ promotedTimestamps: ["2026-01-01T00:00:00", "", 5, null] }));
		expect(readConsolidatorResult(path).promotedTimestamps).toEqual(["2026-01-01T00:00:00"]);
	});

	it("throws when promotedTimestamps is missing", () => {
		const path = join(dir, "bad.json");
		writeFileSync(path, JSON.stringify({ nope: true }));
		expect(() => readConsolidatorResult(path)).toThrow();
	});
});

describe("registerConsolidatorTools (scoped to .memory/)", () => {
	let cwd: string;
	let memoryRoot: string;
	let resultPath: string;
	let tools: Map<string, any>;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "om-cons-tools-"));
		memoryRoot = join(cwd, ".memory");
		resultPath = runResultPath(cwd, "c1");
		tools = new Map();
		const fakePi = { registerTool: (def: any) => tools.set(def.name, def) } as any;
		registerConsolidatorTools(fakePi, memoryRoot, resultPath);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("writes an empty result file on registration", () => {
		expect(readConsolidatorResult(resultPath).promotedTimestamps).toEqual([]);
	});

	it("registers the full scoped tool belt", () => {
		expect([...tools.keys()].sort()).toEqual(["edit", "grep", "ls", "read", "report_promotions", "write"].sort());
	});

	it("write then read a topic file", async () => {
		const res = await tools.get("write").execute("1", { path: "auth.md", content: "---\nid: auth\n---\nbody" });
		expect(res.content[0].text).toContain("Wrote auth.md");
		expect(readFileSync(join(memoryRoot, "auth.md"), "utf-8")).toContain("body");
		const read = await tools.get("read").execute("2", { path: "auth.md" });
		expect(read.content[0].text).toContain("body");
	});

	it("refuses to write or edit INDEX.md", async () => {
		const w = await tools.get("write").execute("1", { path: "INDEX.md", content: "x" });
		expect(w.content[0].text).toContain("generated automatically");
		expect(existsSync(join(memoryRoot, "INDEX.md"))).toBe(false);
	});

	it("rejects paths that escape .memory/", async () => {
		const r = await tools.get("write").execute("1", { path: "../escape.md", content: "x" });
		expect(r.content[0].text).toContain("escapes .memory/");
		expect(existsSync(join(cwd, "escape.md"))).toBe(false);
	});

	it("edit replaces an exact unique substring and rejects ambiguous matches", async () => {
		await tools.get("write").execute("1", { path: "t.md", content: "alpha beta alpha" });
		const ambiguous = await tools.get("edit").execute("2", { path: "t.md", oldText: "alpha", newText: "X" });
		expect(ambiguous.content[0].text).toContain("ambiguous");
		const ok = await tools.get("edit").execute("3", { path: "t.md", oldText: "beta", newText: "BETA" });
		expect(ok.content[0].text).toContain("Edited");
		expect(readFileSync(join(memoryRoot, "t.md"), "utf-8")).toBe("alpha BETA alpha");
	});

	it("ls and grep operate within .memory/", async () => {
		await tools.get("write").execute("1", { path: "auth.md", content: "uses JWT tokens" });
		await tools.get("write").execute("2", { path: "deploy.md", content: "uses fly.io" });
		const ls = await tools.get("ls").execute("3", {});
		expect(ls.content[0].text.split("\n").sort()).toEqual(["auth.md", "deploy.md"]);
		const grep = await tools.get("grep").execute("4", { pattern: "JWT" });
		expect(grep.content[0].text).toContain("auth.md:1");
	});

	it("report_promotions writes the result file", async () => {
		const res = await tools
			.get("report_promotions")
			.execute("1", { promotedTimestamps: ["2026-01-01T00:00:00", "2026-01-01T00:01:00"] });
		expect(res.content[0].text).toContain("Recorded 2 promotions");
		expect(readConsolidatorResult(resultPath).promotedTimestamps).toEqual([
			"2026-01-01T00:00:00",
			"2026-01-01T00:01:00",
		]);
	});
});
