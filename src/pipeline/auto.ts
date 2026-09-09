import { AgentResult, PipelineOptions } from "../types";
import { runPipeline, resumePipeline } from "./pipeline";
import { isPauseSignal, BudgetExceededError, RateLimitError } from "../budget/errors";

const DEFAULT_MAX_SLEEP_SEC = 3600;

export interface AutoResumeOptions {
  /** Longest single wait to sleep through. Longer waits fall back to manual resume. */
  maxSleepSec?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function msUntilNextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return next - nowMs;
}

/**
 * How long to wait before a pause can be retried, or null if waiting won't help.
 *  - 429: until the rate-limit reset.
 *  - day budget cap: until the next UTC midnight (the ledger rolls over).
 *  - per-run budget cap: null — it never resets, so sleeping is pointless.
 */
export function resumeDelayMs(err: unknown, now: () => number): number | null {
  if (err instanceof RateLimitError) return Math.max(0, err.resumeAtMs - now());
  if (err instanceof BudgetExceededError) {
    return err.scope === "run" ? null : msUntilNextUtcMidnight(now());
  }
  return null;
}

/**
 * Run a pipeline unattended: on a sleepable pause, wait until the limit resets and
 * resume the same (checkpointed) run in-process. Falls through — rethrowing the pause
 * signal for the caller to print a manual-resume hint — when the wait is un-sleepable
 * (per-run cap) or exceeds `maxSleepSec`.
 */
/**
 * Generic unattended runner: run `start()`; on a sleepable pause, wait out the limit
 * and call `resume(runId)`, repeating until it finishes. Rethrows un-sleepable pauses
 * (per-run cap) or waits over `maxSleepSec` for the caller to handle manual resume.
 * Shared by the greenfield pipeline and workspace mode.
 */
export async function withAutoResume<T>(
  start: () => Promise<T>,
  resume: (runId: string) => Promise<T>,
  auto: AutoResumeOptions = {}
): Promise<T> {
  const maxSleepSec =
    auto.maxSleepSec ??
    parseInt(process.env.AUTO_SLEEP_MAX_SEC ?? String(DEFAULT_MAX_SLEEP_SEC), 10);
  const now = auto.now ?? Date.now;
  const sleep = auto.sleep ?? defaultSleep;

  let attempt = start;

  // Bounded loop guard against a run that keeps re-pausing immediately.
  for (let guard = 0; guard < 1000; guard++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isPauseSignal(err)) throw err;

      const runId = (err as { runId?: string }).runId;
      const waitMs = resumeDelayMs(err, now);

      if (runId === undefined || waitMs === null || waitMs / 1000 > maxSleepSec) {
        throw err; // un-sleepable or too long — let the caller handle manual resume
      }

      console.log(
        `\n⏸  ${err.message} — sleeping ${Math.ceil(waitMs / 1000)}s, then resuming ${runId}...`
      );
      await sleep(waitMs);
      attempt = () => resume(runId);
    }
  }
  throw new Error("withAutoResume: exceeded resume attempt guard");
}

export async function runAutoResume(
  task: string,
  options: PipelineOptions,
  auto: AutoResumeOptions = {}
): Promise<AgentResult[]> {
  return withAutoResume(
    () => runPipeline(task, options),
    (runId) => resumePipeline(runId, options),
    auto
  );
}
