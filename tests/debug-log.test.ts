import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	DEBUG_LOG_MAX_BYTES,
	DEBUG_LOG_RELATIVE_PATH,
	DEBUG_LOG_SESSION_DIR_RELATIVE_PATH,
	debugLog,
	debugLogRelativePath,
	safeDebugLogSessionId,
	withDebugLogContext,
} from "../src/debug-log.js";

/**
 * `src/debug-log.ts` is the opt-in forensic trail for memory behaviour (config.debugLog), and it
 * had no tests at all: its session-id sanitising, its per-session vs shared file choice, its
 * size rotation, and its "never throw into the host" contract were all unexercised. Writes are
 * redirected into a temp dir by pointing pi's agent-dir env var at it, so no test touches the
 * real ~/.pi/agent tree.
 */

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

describe("debug-log paths", () => {
	it("sanitises a session id into a filename-safe token", () => {
		expect(safeDebugLogSessionId("  01J/AB:cd  ")).toBe("01J_AB_cd");
		expect(safeDebugLogSessionId("a/b")).toBe("a_b");
	});

	it("treats blank and alphanumeric-free ids as absent", () => {
		expect(safeDebugLogSessionId(undefined)).toBeUndefined();
		expect(safeDebugLogSessionId("   ")).toBeUndefined();
		// Sanitising can leave only punctuation, which is a valid filename but not a real id.
		expect(safeDebugLogSessionId("///")).toBeUndefined();
		expect(safeDebugLogSessionId("!!!")).toBeUndefined();
		expect(safeDebugLogSessionId("__..__")).toBeUndefined();
	});
});

describe("debugLog", () => {
	const roots: string[] = [];
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		savedAgentDir = process.env[AGENT_DIR_ENV];
	});

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = savedAgentDir;
		for (const root of roots) rmSync(root, { recursive: true, force: true });
		roots.length = 0;
	});

	function tempDir(): string {
		const root = mkdtempSync(join(tmpdir(), "om-debug-log-"));
		roots.push(root);
		process.env[AGENT_DIR_ENV] = root;
		return root;
	}

	it("writes nothing unless a context enables it", () => {
		const agentDir = tempDir();
		debugLog("no-context");
		withDebugLogContext({ enabled: false }, () => debugLog("disabled"));
		expect(existsSync(join(agentDir, DEBUG_LOG_RELATIVE_PATH))).toBe(false);
	});

	it("writes one ndjson line carrying the merged context and the event data", () => {
		const agentDir = tempDir();
		withDebugLogContext({ enabled: true, cwd: "/proj" }, () => {
			withDebugLogContext({ enabled: true, runId: "obs-1" }, () => debugLog("observer.commit", { count: 2 }));
		});

		const lines = readFileSync(join(agentDir, DEBUG_LOG_RELATIVE_PATH), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(record.event).toBe("observer.commit");
		expect(record.cwd).toBe("/proj");
		expect(record.runId).toBe("obs-1");
		expect(record.data).toEqual({ count: 2 });
		expect(typeof record.ts).toBe("string");
	});

	it("splits per-session logs out of the shared file when a session id is present", () => {
		const agentDir = tempDir();
		withDebugLogContext({ enabled: true, sessionId: "sess/1" }, () => debugLog("turn"));

		const sessionFile = join(agentDir, DEBUG_LOG_SESSION_DIR_RELATIVE_PATH, "sess_1.ndjson");
		expect(existsSync(sessionFile)).toBe(true);
		expect(readFileSync(sessionFile, "utf-8")).toContain('"event":"turn"');
		expect(existsSync(join(agentDir, DEBUG_LOG_RELATIVE_PATH))).toBe(false);
		expect(debugLogRelativePath({ sessionId: "sess/1" })).toBe(
			join(DEBUG_LOG_SESSION_DIR_RELATIVE_PATH, "sess_1.ndjson"),
		);
	});

	it("rotates the log to .1 once it reaches the size cap, replacing an older backup", () => {
		const agentDir = tempDir();
		const path = join(agentDir, DEBUG_LOG_RELATIVE_PATH);
		mkdirSync(join(agentDir, "observational-memory"), { recursive: true });
		writeFileSync(path, "seed");
		truncateSync(path, DEBUG_LOG_MAX_BYTES);
		writeFileSync(`${path}.1`, "stale backup");

		withDebugLogContext({ enabled: true }, () => debugLog("after-rotation"));

		expect(statSync(`${path}.1`).size).toBe(DEBUG_LOG_MAX_BYTES);
		const fresh = readFileSync(path, "utf-8");
		expect(fresh.trim().split("\n")).toHaveLength(1);
		expect(fresh).toContain('"event":"after-rotation"');
	});

	it("keeps the log below the cap untouched", () => {
		const agentDir = tempDir();
		const path = join(agentDir, DEBUG_LOG_RELATIVE_PATH);
		mkdirSync(join(agentDir, "observational-memory"), { recursive: true });
		writeFileSync(path, "small\n");
		truncateSync(path, DEBUG_LOG_MAX_BYTES - 1);

		withDebugLogContext({ enabled: true }, () => debugLog("appended"));

		expect(existsSync(`${path}.1`)).toBe(false);
		expect(readFileSync(path, "utf-8")).toContain('"event":"appended"');
	});

	it("swallows a write error instead of surfacing it to the host", () => {
		const agentDir = tempDir();
		// A regular file where the agent dir should be: the log directory cannot be created.
		const blocked = join(agentDir, "blocked");
		writeFileSync(blocked, "not a directory");
		process.env[AGENT_DIR_ENV] = blocked;

		expect(() => withDebugLogContext({ enabled: true }, () => debugLog("boom"))).not.toThrow();
		expect(readFileSync(blocked, "utf-8")).toBe("not a directory");
	});
});
