import Database from "better-sqlite3";
import path from "path";
import { AgentResult } from "../types";

const DB_PATH = path.join(process.cwd(), "checkpoints.db");

export type RunStatus = "running" | "paused" | "done" | "failed";

/** Full persisted state of a pipeline run — enough to resume from exactly where it stopped. */
export interface RunState {
  runId: string;
  task: string;
  status: RunStatus;
  /** Index of the NEXT agent to run. Always points past any completed step. */
  currentIndex: number;
  retryCounts: Record<string, number>;
  history: AgentResult[];
  runTokens: number;
  /** Free local (Ollama) tokens used this run — counted for visibility, never charged. */
  localTokens?: number;
  /** Agent names in pipeline order, used to re-bind configs on resume. */
  agentNames: string[];
  noMemory: boolean;
  pausedReason?: string;
  createdAt: string;
  updatedAt: string;
  /** Workspace-mode fields (null for greenfield pipeline runs). */
  projectName?: string;
  branch?: string;
  iteration?: number;
}

interface Row {
  run_id: string;
  task: string;
  status: RunStatus;
  current_index: number;
  retry_counts: string;
  history: string;
  run_tokens: number;
  local_tokens: number;
  agent_names: string;
  no_memory: number;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
  project_name: string | null;
  branch: string | null;
  iteration: number | null;
}

function reviveHistory(json: string): AgentResult[] {
  const raw = JSON.parse(json) as (Omit<AgentResult, "timestamp"> & { timestamp: string })[];
  return raw.map((r) => ({ ...r, timestamp: new Date(r.timestamp) }));
}

function rowToState(row: Row): RunState {
  return {
    runId: row.run_id,
    task: row.task,
    status: row.status,
    currentIndex: row.current_index,
    retryCounts: JSON.parse(row.retry_counts),
    history: reviveHistory(row.history),
    runTokens: row.run_tokens,
    localTokens: row.local_tokens ?? 0,
    agentNames: JSON.parse(row.agent_names),
    noMemory: row.no_memory === 1,
    pausedReason: row.paused_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectName: row.project_name ?? undefined,
    branch: row.branch ?? undefined,
    iteration: row.iteration ?? undefined,
  };
}

/** SQLite-backed run checkpoints. One row per run; upserted after every step. */
export class CheckpointStore {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id        TEXT PRIMARY KEY,
        task          TEXT NOT NULL,
        status        TEXT NOT NULL,
        current_index INTEGER NOT NULL,
        retry_counts  TEXT NOT NULL,
        history       TEXT NOT NULL,
        run_tokens    INTEGER NOT NULL,
        local_tokens  INTEGER NOT NULL DEFAULT 0,
        agent_names   TEXT NOT NULL,
        no_memory     INTEGER NOT NULL,
        paused_reason TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        project_name  TEXT,
        branch        TEXT,
        iteration     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_status ON runs(status);
    `);
    this.migrate();
  }

  /** Add columns introduced after a db was first created (backward compatible). */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map((c) => c.name)
    );
    const added: [string, string][] = [
      ["project_name", "TEXT"],
      ["branch", "TEXT"],
      ["iteration", "INTEGER"],
      ["local_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, decl] of added) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${decl}`);
    }
  }

  /** Insert or update the full run state (timestamps managed by caller via `state`). */
  save(state: RunState): void {
    this.db
      .prepare(
        `INSERT INTO runs
           (run_id, task, status, current_index, retry_counts, history,
            run_tokens, local_tokens, agent_names, no_memory, paused_reason, created_at, updated_at,
            project_name, branch, iteration)
         VALUES (@run_id, @task, @status, @current_index, @retry_counts, @history,
                 @run_tokens, @local_tokens, @agent_names, @no_memory, @paused_reason, @created_at, @updated_at,
                 @project_name, @branch, @iteration)
         ON CONFLICT(run_id) DO UPDATE SET
           status=excluded.status, current_index=excluded.current_index,
           retry_counts=excluded.retry_counts, history=excluded.history,
           run_tokens=excluded.run_tokens, local_tokens=excluded.local_tokens,
           paused_reason=excluded.paused_reason,
           updated_at=excluded.updated_at, branch=excluded.branch,
           iteration=excluded.iteration`
      )
      .run({
        run_id: state.runId,
        task: state.task,
        status: state.status,
        current_index: state.currentIndex,
        retry_counts: JSON.stringify(state.retryCounts),
        history: JSON.stringify(state.history),
        run_tokens: state.runTokens,
        local_tokens: state.localTokens ?? 0,
        agent_names: JSON.stringify(state.agentNames),
        no_memory: state.noMemory ? 1 : 0,
        paused_reason: state.pausedReason ?? null,
        created_at: state.createdAt,
        updated_at: state.updatedAt,
        project_name: state.projectName ?? null,
        branch: state.branch ?? null,
        iteration: state.iteration ?? null,
      });
  }

  get(runId: string): RunState | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as
      | Row
      | undefined;
    return row ? rowToState(row) : undefined;
  }

  /** Runs that can be resumed (paused or interrupted mid-flight), newest first. */
  listResumable(): RunState[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status IN ('paused','running') ORDER BY updated_at DESC`)
      .all() as Row[];
    return rows.map(rowToState);
  }
}
