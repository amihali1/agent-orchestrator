import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "budget.db");

/**
 * SQLite-backed daily token ledger. Persists across runs so the per-day cap
 * survives process restarts (and, in Phase 3, pause/resume).
 */
export class TokenLedger {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        day    TEXT PRIMARY KEY,
        tokens INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  /** Add tokens to a day's running total (UTC day key, YYYY-MM-DD). */
  add(day: string, tokens: number): void {
    this.db
      .prepare(
        `INSERT INTO token_usage (day, tokens) VALUES (?, ?)
         ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens`
      )
      .run(day, tokens);
  }

  /** Total tokens recorded for a day. */
  get(day: string): number {
    const row = this.db
      .prepare(`SELECT tokens FROM token_usage WHERE day = ?`)
      .get(day) as { tokens: number } | undefined;
    return row?.tokens ?? 0;
  }
}
