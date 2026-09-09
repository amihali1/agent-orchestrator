/** Token caps. 0 = unlimited. */
export interface BudgetConfig {
  maxTokensPerRun: number;
  maxTokensPerDay: number;
}

function parseCap(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Read caps from env: MAX_TOKENS_PER_RUN, MAX_TOKENS_PER_DAY. Missing/invalid = unlimited. */
export function loadBudgetConfig(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
  return {
    maxTokensPerRun: parseCap(env.MAX_TOKENS_PER_RUN),
    maxTokensPerDay: parseCap(env.MAX_TOKENS_PER_DAY),
  };
}
