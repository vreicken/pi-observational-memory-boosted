/**
 * `.memory/` substrate (Phase B). The filesystem IS the long-term recall interface: the master
 * reads topic files with ordinary `ls`/`read`/`grep`. Topic files are NOT rolled back by `/tree`
 * (they track the repo, not the session branch).
 *
 * Layout under <project>/.memory/:
 *   INDEX.md            — orchestrator-owned; (re)rendered from topic front-matter
 *   <topic>.md          — consolidator-authored; YAML front-matter + current-state prose
 *   .runs/<id>.json     — transient worker IPC (not GC'd in v1)
 *
 * All writes are atomic (temp + rename) so a reader never sees a half-written file.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const INDEX_FILENAME = "INDEX.md";
/**
 * The running, whole-project descriptive history. Consolidator-authored prose (no front-matter),
 * pushed into every compaction block for orientation. Like INDEX.md it is a special file, NOT a
 * topic file: it is excluded from `listTopics`/the memory map and read verbatim at compaction.
 */
export const JOURNEY_FILENAME = "JOURNEY.md";

export function memoryDir(cwd: string): string {
	return join(cwd, ".memory");
}

export function indexPath(cwd: string): string {
	return join(memoryDir(cwd), INDEX_FILENAME);
}

export function journeyPath(cwd: string): string {
	return join(memoryDir(cwd), JOURNEY_FILENAME);
}

/** Read `.memory/JOURNEY.md` body, trimmed. Returns undefined when missing or effectively empty. */
export function readJourney(cwd: string): string | undefined {
	const path = journeyPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		const body = readFileSync(path, "utf-8").trim();
		return body.length > 0 ? body : undefined;
	} catch {
		return undefined;
	}
}

/** Atomic write (temp + rename). Creates parent dirs as needed. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, path);
}

/**
 * Resolve a (possibly relative) path and confirm it stays inside `.memory/`. Returns the
 * absolute path, or undefined if it escapes the sandbox. The consolidator's scoped tools use
 * this to reject any path outside `.memory/` (design risk 6).
 */
export function resolveWithinMemory(cwd: string, requestedPath: string): string | undefined {
	const root = resolve(memoryDir(cwd));
	const abs = resolve(root, requestedPath);
	const rel = relative(root, abs);
	if (rel === "" || rel === ".") return abs; // the .memory dir itself
	if (rel.startsWith("..") || resolve(root, rel) !== abs) return undefined;
	return abs;
}

export type TopicFrontMatter = {
	id?: string;
	title?: string;
	summary?: string;
	updated?: string;
};

export type Topic = TopicFrontMatter & {
	/** Path relative to the project root, e.g. ".memory/auth.md". */
	path: string;
	/** Bare filename, e.g. "auth.md". */
	filename: string;
};

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Parse leading YAML-ish front-matter. Intentionally tiny (no YAML dep): supports the flat
 * `key: value` fields the consolidator authors (id, title, summary, updated). Returns the
 * parsed fields plus the body after the front-matter block.
 */
export function parseFrontMatter(content: string): { front: TopicFrontMatter; body: string } {
	const match = FRONT_MATTER_RE.exec(content);
	if (!match) return { front: {}, body: content };
	const front: TopicFrontMatter = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key === "id" || key === "title" || key === "summary" || key === "updated") {
			front[key] = value;
		}
	}
	return { front, body: content.slice(match[0].length) };
}

/** List parsed topic files (every `*.md` except INDEX.md), sorted by filename. */
export function listTopics(cwd: string): Topic[] {
	const dir = memoryDir(cwd);
	if (!existsSync(dir)) return [];
	const topics: Topic[] = [];
	for (const filename of readdirSync(dir)) {
		if (!filename.endsWith(".md") || filename === INDEX_FILENAME || filename === JOURNEY_FILENAME) continue;
		let content: string;
		try {
			content = readFileSync(join(dir, filename), "utf-8");
		} catch {
			continue;
		}
		const { front } = parseFrontMatter(content);
		topics.push({ ...front, path: join(".memory", filename), filename });
	}
	topics.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
	return topics;
}
