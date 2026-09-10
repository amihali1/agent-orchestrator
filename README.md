# Agent Pipeline

A sequential multi-agent pipeline powered by the Claude API. Agents hand off work to each other in order, with automatic retry loops when a downstream agent requests revisions. Past decisions are stored in SQLite so agents can recall similar work and avoid redundant processing.

## How it works

```
Designer → Engineer → Tester → Reviewer
                ↑         ↑
           (revision) (revision)
```

The Designer defines the spec first — UX requirements, component structure, accessibility constraints, and behaviour. The Engineer implements against that spec. The Tester verifies correctness and the Reviewer checks quality. If the Tester or Reviewer finds problems, the pipeline jumps back to the Engineer (up to a configurable retry limit), then continues forward again.

Each agent also receives relevant memories from past runs, so similar tasks benefit from previous decisions.

## Setup

```bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

npm install
```

## Usage

```bash
# Run with the default example task
npm run dev

# Run with a custom task
npm run dev -- "Create a TypeScript class that manages a job queue with priority levels"

# Run without memory (fresh start, no prior context)
npm run dev -- --no-memory

# Combine both
npm run dev -- --no-memory "Build a REST API for managing todos"
```

Final outputs are printed to the console and saved to the `output/` directory as markdown files (e.g., `output/designer.md`, `output/engineer.md`).

### Cached task detection

If you run a task that has already been completed, the pipeline will prompt you instead of re-running:

```
This task has already been completed. Cached results found for all 4 agents.

Use cached results? (y)es / (r)e-run / (f)resh run (no memory):
```

- **`y`** — serves cached results instantly with zero API calls
- **`r`** — re-runs the pipeline with memory (agents see prior work as context)
- **`f`** — re-runs from scratch with no memory injected

Use `--no-memory` to skip this check entirely.

### Running a single agent

Run any agent individually without the full pipeline:

```bash
# Run designer on a task
npm run agent -- designer "Build a REST API"

# Run engineer with designer's output as input
npm run agent -- engineer "Build a REST API" --input output/designer.md

# Chain agents step by step
npm run agent -- designer "Build a REST API"
npm run agent -- engineer "Build a REST API" --input output/designer.md
npm run agent -- tester "Build a REST API" --input output/engineer.md
npm run agent -- reviewer "Build a REST API" --input output/tester.md

# Pipe from stdin
cat output/designer.md | npm run agent -- engineer "Build a REST API" --input -

# Run without memory
npm run agent -- designer --no-memory "Build a REST API"
```

Each run saves its output to `output/<agent>.md`, so agents can be chained manually.

### Scaffolding a project

After running the pipeline, scaffold the generated code into a new project:

```bash
npm run scaffold my-new-project
```

This reads the latest agent outputs from `memory.db` and creates a ready-to-use project:

- Extracts code files from the engineer and tester outputs (using `## File: path` headers)
- Saves the designer's spec as `DESIGN.md` and reviewer notes as `REVIEW.md`
- Generates `package.json` and `tsconfig.json` if the agents didn't include them
- Initializes a git repository

```bash
cd my-new-project
npm install
npm test
```

## Workspace mode (edit an existing repo)

Workspace mode runs a task against a real repo behind a **profile** (`profiles/<name>.json`: repo path, verifier gate commands, context globs). It creates an `agent/…` branch, has the engineer edit the gathered files, runs the profile's real gates (build/typecheck/lint/test), and commits on green:

```bash
npm run workspace -- <project> "<task>" [--files a.ts,b.ts] [--dry-run]
```

Gate scripts live in `profiles/gates/` and are referenced from a profile via the `${GATES}` token (expanded to an absolute path at load time), so committed profiles stay portable. The Unity gate reads the editor path from `$UNITY_EXE`.

## Bootstrap (start a project from nothing)

Bootstrap turns nothing into a minimal, gate-green git repo plus a registered profile, so the plan/backlog spine can build a brand-new project from a goal.

```bash
npm run bootstrap -- <name> [--goal "<goal>"] [--base <dir>] [--no-install]
```

It writes a TS/Node skeleton (`package.json`, `tsconfig`, `src` + a passing test), runs `git init` + an initial commit, `npm install`s, and saves `profiles/<name>.json` (gates: `tsc --noEmit` + `vitest run`). With `--goal`, it then plans and runs the backlog on the fresh repo. Projects are created under `$BOOTSTRAP_BASE` (default `C:/Dev`) unless `--base` is given.

## Planning (goal → task list)

The Planner turns a one-line goal into an ordered task backlog (the same format the backlog driver consumes). It sees a cheap structural context — the repo file list plus README — and returns a task list, without touching git.

```bash
# Print a plan for review (optionally write it to a file):
npm run plan -- <project> "<goal>" [--out backlog.json]
```

The Planner runs on the smart tier by default; set `TIER_PLANNER=local` to use the free local model (lower quality).

## Backlog mode (many tasks, one branch)

Backlog mode drives an **ordered list of tasks** through workspace mode on a single branch — committing each task on green, so multiple pieces ship with a real gate run between them. It halts on the first task that can't pass its gate, leaving the branch and prior commits for inspection.

```bash
npm run backlog -- <project> <backlog-file> [--dry-run]
npm run backlog -- <project> --goal "<goal>" [--dry-run]   # plan, then run
npm run backlog -- --resume <backlog_id>
```

`<backlog-file>` is either a `.json` array of task strings or a markdown `- ` checklist. With `--goal`, the Planner generates the task list first and the driver runs it end-to-end. Progress is checkpointed to `backlogs.db` after each task; budget pauses auto-sleep and resume. The run reports billable (Claude) vs free local (Ollama) token usage.

## Testing

The project includes a test suite built with [Vitest](https://vitest.dev/) covering the memory store, pipeline orchestration, and agent runner.

```bash
# Run tests once
npm test

# Run in watch mode
npm run test:watch
```

Tests run automatically on push/PR to `main` via GitHub Actions (Node 18, 20, 22).

### What's tested

- **Memory store** — save/recall, exact match vs fallback, cache detection, agent isolation, `--no-memory` behavior, data integrity
- **Pipeline** — sequential execution, agent handoff/revision loops, `maxRetries` enforcement, `onAgentComplete` callback
- **Runner** — structured tool output extraction, text-only fallback, memory recall/save integration, message construction, API parameters

## Project structure

```
src/
├── agents/
│   ├── designer.ts    # defines the design spec before any code is written
│   ├── engineer.ts    # implements against the designer's spec
│   ├── tester.ts      # writes tests, can send back to engineer
│   ├── reviewer.ts    # reviews quality, can send back to engineer
│   └── index.ts
├── memory/
│   └── store.ts       # SQLite-backed memory (save + recall past decisions)
├── pipeline/
│   ├── runner.ts      # calls Claude with structured tool output
│   └── pipeline.ts    # orchestrates the sequence and retry logic
├── scaffold.ts        # creates a project from pipeline outputs
├── run-agent.ts       # runs a single agent independently
├── types.ts
└── index.ts           # entry point, saves outputs to output/
```

## Adding an agent

1. Create `src/agents/myagent.ts`:

```typescript
import { AgentConfig } from "../types";

export const myAgent: AgentConfig = {
  name: "myagent",
  systemPrompt: `You are a ... Your job is to ...`,
  onRevision: "engineer", // optional: jump back to this agent on failure
  maxRetries: 3,
};
```

2. Export it from `src/agents/index.ts`
3. Add it to the `agents` array in `src/index.ts`

## Memory

Agent decisions are stored in `memory.db` (SQLite) after each successful run. On future runs, each agent automatically receives relevant past decisions as context. The DB is gitignored — delete it to start fresh.

For the same task, memory recall finds an exact match and returns the agent's most recent output. For a new task, it falls back to the agent's 3 most recent memories from any task, giving it a sense of patterns from prior work.

Use `--no-memory` to skip recall entirely, or delete `memory.db` to wipe all history.

## Configuration

Each agent config accepts:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique agent identifier |
| `systemPrompt` | `string` | The agent's role and instructions |
| `onRevision` | `string?` | Agent to retry when this one returns `needs_revision` |
| `maxRetries` | `number?` | Max retries for this agent (default: 3) |
