export type PauseReason = "budget" | "rate_limit";

/** Raised when a self-imposed run/day token cap is crossed. A pause signal. */
export class BudgetExceededError extends Error {
  readonly pauseReason: PauseReason = "budget";
  constructor(
    public scope: "run" | "day",
    public used: number,
    public cap: number
  ) {
    super(`Budget exceeded (${scope}): ${used}/${cap} tokens`);
    this.name = "BudgetExceededError";
  }
}

/** Raised when the API returns HTTP 429. A pause signal carrying when to resume. */
export class RateLimitError extends Error {
  readonly pauseReason: PauseReason = "rate_limit";
  constructor(
    public retryAfterSec: number,
    public resumeAtMs: number
  ) {
    super(`Rate limited; retry after ${retryAfterSec}s`);
    this.name = "RateLimitError";
  }
}

/** True for either pause signal. Phases 3/4 (checkpoint + auto-sleep) branch on this. */
export function isPauseSignal(
  e: unknown
): e is BudgetExceededError | RateLimitError {
  return e instanceof BudgetExceededError || e instanceof RateLimitError;
}
