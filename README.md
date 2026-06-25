# observational-memory

Tiered, subprocess-backed memory for pi. Parallel **observers** distill raw conversation
chunks into atomic observations committed to the master's branch-local **ledger** (so memory
stays correct under `/tree`); a deterministic, model-free **compaction** renders that buffer
verbatim into the compaction block. A **consolidator** that promotes the oldest observations
into durable `.memory/` topic files arrives in Phase B.

See `PLAN.md` for the implementation plan and the design doc it derives from.

> **Status: Phase A.** Short-term tier + TUI + compaction. No `.memory/` files and no
> consolidator yet, so the observation buffer is **not yet bounded** — it grows until
> compaction renders it (an acceptable, fully-testable intermediate state). Bounding arrives
> with the Phase B consolidator.

## On/off gate (default OFF)

The extension ships in the global extensions folder during development, so it is **gated off
per session** and is completely invisible until you turn it on.

- `/om` — toggle for this session
- `/om on` / `/om off` — set explicitly

State persists per session in the ledger (`om.enabled`) and survives resume. When off, every
trigger, hook, widget, and subprocess returns immediately.

## How it works (Phase A)

```
raw chunks ─[parallel observers]─▶ observations ──▶ master ledger ──▶ compaction block
 (token-bounded,  (subprocess pi,    {timestamp,        (branch-local,   (deterministic,
  fixed slices)    headless)          content}           /tree-correct)   model-free)
```

- **Observer clock** (`turn_end` / `agent_start`): every `chunkTokens` of new raw history,
  cut a fixed-token slice and fire an observer subprocess. Observers are embarrassingly
  parallel pure mappers (capped by `observerConcurrency`); each commits its own
  `coversUpToId` watermark, so out-of-order completion is fine.
- **Observation** = `{ timestamp, content, tokenCount }`. The precise event-`timestamp`
  doubles as the id; the orchestrator re-derives a unique, second-resolution id at commit
  (the observer only emits minute resolution).
- **Compaction** (`agent_end` over `compactAtContextTokens`, when idle): waits for in-flight
  observers, then renders the active buffer. The cutoff snaps to an observation chunk
  boundary so the verbatim tail is never double-represented.

Each worker is an **ordinary recorded pi session** in the global store
(`~/.pi/agent/sessions`, under the project path) — open it in the session browser to see the
exact input chunk, tool calls, and output. Transient handoff files live in
`<project>/.memory/.runs/`.

## Commands

| Command | Effect |
|---|---|
| `/om`, `/om on`, `/om off` | The per-session on/off gate |
| `/om:status` | Workers in flight, active observation count, next-observer token progress, context usage, last error |
| `/om:compact` | Force a compaction now (ignores the threshold) |

## Configuration

Namespace `observational-memory` in `~/.pi/agent/settings.json` (global) or
`.pi/settings.json` (project; overrides global):

```jsonc
{
  "observational-memory": {
    "chunkTokens": 5000,
    "chunkOverlapTokens": 0,
    "poolTargetTokens": 10000,           // Phase B
    "consolidateAtPoolTokens": 20000,    // Phase B
    "compactAtContextTokens": 100000,    // tune per model
    "tailTokens": 20000,                 // verbatim tail; snaps to a chunk boundary
    "observerConcurrency": 4,
    "models": {
      "observer":     { "provider": "anthropic", "id": "claude-sonnet-4-6", "thinking": "low" },
      "consolidator": { "provider": "anthropic", "id": "claude-sonnet-4-6", "thinking": "medium" }
    },
    "passive": false,
    "debugLog": false
  }
}
```

`PI_OM_PASSIVE=1` forces `passive` (disables all triggers) for clean `/tree` testing.
`passive` is a power-user setting distinct from the on/off gate.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Layout: `src/` is the master-side orchestrator (entry `src/index.ts`); `agent/` is the shared
worker extension loaded into subprocesses via `-e` (`OM_WORKER=observer|consolidator`).
