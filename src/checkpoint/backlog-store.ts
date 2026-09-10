import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "backlogs.db");

export type BacklogStatus = "running" | "paused" | "done" | "failed";
export type TaskStatus = "pending" | "done" | "failed";

export interface TaskOutcome {
  task: string;
  status: TaskStatus;
  commit?: string;
}

/** Full persisted state of a backlog run — enough to resume from the current task. */
export interface BacklogState {
  backlogId: string;
  projectName: string;
  branch: string;
  status: BacklogStatus;
  tasks: TaskOutcome[];
  /** Index of the NEXT task to run. */
  currentIndex: number;
  runTokens: number;
  localTokens: number;
  pausedReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  backlog_id: string;
  project_name: string;
  branch: string;
  status: BacklogStatus;
  tasks: string;
  current_index: number;
  run_tokens: number;
  local_tokens: number;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToState(row: Row): BacklogState {
  return {
    backlogId: row.backlog_id,
    projectName: row.project_name,
    branch: row.branch,
    status: row.status,
    tasks: JSON.parse(row.tasks),
    currentIndex: row.current_index,
    runTokens: row.run_tokens,
    localTokens: row.local_tokens,
    pausedReason: row.paused_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite-backed backlog checkpoints. One row per backlog run; upserted after each task. */
export class BacklogStore {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backlog_runs (
        backlog_id    TEXT PRIMARY KEY,
        project_name  TEXT NOT NULL,
        branch        TEXT NOT NULL,
        status        TEXT NOT NULL,
        tasks         TEXT NOT NULL,
        current_index INTEGER NOT NULL,
        run_tokens    INTEGER NOT NULL,
        local_tokens  INTEGER NOT NULL,
        paused_reason TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backlog_status ON backlog_runs(status);
    `);
  }

  save(state: BacklogState): void {
    this.db
      .prepare(
        `INSERT INTO backlog_runs
           (backlog_id, project_name, branch, status, tasks, current_index,
            run_tokens, local_tokens, paused_reason, created_at, updated_at)
         VALUES (@backlog_id, @project_name, @branch, @status, @tasks, @current_index,
                 @run_tokens, @local_tokens, @paused_reason, @created_at, @updated_at)
         ON CONFLICT(backlog_id) DO UPDATE SET
           status=excluded.status, tasks=excluded.tasks,
           current_index=excluded.current_index, run_tokens=excluded.run_tokens,
           local_tokens=excluded.local_tokens, paused_reason=excluded.paused_reason,
           updated_at=excluded.updated_at`
      )
      .run({
        backlog_id: state.backlogId,
        project_name: state.projectName,
        branch: state.branch,
        status: state.status,
        tasks: JSON.stringify(state.tasks),
        current_index: state.currentIndex,
        run_tokens: state.runTokens,
        local_tokens: state.localTokens,
        paused_reason: state.pausedReason ?? null,
        created_at: state.createdAt,
        updated_at: state.updatedAt,
      });
  }

  get(backlogId: string): BacklogState | undefined {
    const row = this.db.prepare(`SELECT * FROM backlog_runs WHERE backlog_id = ?`).get(backlogId) as
      | Row
      | undefined;
    return row ? rowToState(row) : undefined;
  }

  /** Backlog runs that can be resumed (paused or interrupted mid-flight), newest first. */
  listResumable(): BacklogState[] {
    const rows = this.db
      .prepare(`SELECT * FROM backlog_runs WHERE status IN ('paused','running') ORDER BY updated_at DESC`)
      .all() as Row[];
    return rows.map(rowToState);
  }
}
