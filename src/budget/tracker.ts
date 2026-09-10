import { Usage } from "../types";
import { BudgetConfig } from "./config";
import { TokenLedger } from "./ledger";
import { BudgetExceededError } from "./errors";

export interface BudgetSnapshot {
  runTokens: number;
  dayTokens: number;
  maxRun: number;
  maxDay: number;
  /** Free local (Ollama) tokens used this run — counted for visibility, never charged. */
  localTokens: number;
}

/**
 * Accumulates token usage for a run and enforces run/day caps.
 *
 * Usage flow: the runner calls `record(usage)` after every completion; the
 * pipeline calls `assertWithinBudget()` once the step is safely recorded, so a
 * pause fires *between* steps (Phase 3 resume then continues from the next one).
 * Local (Ollama) completions report 0 tokens, so they never consume budget.
 */
export class BudgetTracker {
  private runTokens: number;
  private localTokens: number;

  constructor(
    private readonly config: BudgetConfig,
    private readonly ledger: TokenLedger,
    private readonly now: () => Date = () => new Date(),
    startRunTokens = 0,
    startLocalTokens = 0
  ) {
    this.runTokens = startRunTokens;
    this.localTokens = startLocalTokens;
  }

  /** UTC day key. */
  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /**
   * Add a completion's tokens to the totals. Billable (Claude) tokens go to the run
   * total and the persistent day ledger; non-billable (local/Ollama) tokens are
   * tallied separately for visibility and never touch the budget caps.
   */
  record(usage: Usage): void {
    const n = usage.inputTokens + usage.outputTokens;
    if (n <= 0) return;
    if (usage.billable === false) {
      this.localTokens += n;
      return;
    }
    this.runTokens += n;
    this.ledger.add(this.today(), n);
  }

  /** Throw a pause signal if either cap has been crossed. Call after `record()`. */
  assertWithinBudget(): void {
    if (this.config.maxTokensPerRun > 0 && this.runTokens >= this.config.maxTokensPerRun) {
      throw new BudgetExceededError("run", this.runTokens, this.config.maxTokensPerRun);
    }
    if (this.config.maxTokensPerDay > 0) {
      const day = this.ledger.get(this.today());
      if (day >= this.config.maxTokensPerDay) {
        throw new BudgetExceededError("day", day, this.config.maxTokensPerDay);
      }
    }
  }

  snapshot(): BudgetSnapshot {
    return {
      runTokens: this.runTokens,
      dayTokens: this.ledger.get(this.today()),
      maxRun: this.config.maxTokensPerRun,
      maxDay: this.config.maxTokensPerDay,
      localTokens: this.localTokens,
    };
  }
}
