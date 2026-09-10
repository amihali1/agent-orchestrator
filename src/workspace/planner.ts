import fs from "fs";
import path from "path";
import { BudgetTracker } from "../budget/tracker";
import { TokenLedger } from "../budget/ledger";
import { loadBudgetConfig } from "../budget/config";
import { runAgent } from "../pipeline/runner";
import { loadProfile } from "./profile";
import { listRepoFiles, renderPlanContext } from "./gather";
import { plannerAgent } from "./agents";
import { parseTaskList } from "./tasklist";

export interface PlanOptions {
  tracker?: BudgetTracker;
  maxFiles?: number;
}

export interface PlanResult {
  tasks: string[];
  tokens: { run: number; local: number };
}

/** Parse the planner's model output into a task list (JSON array or markdown). */
export function parsePlannerOutput(text: string): string[] {
  return parseTaskList(text);
}

/**
 * Turn a high-level goal into an ordered task backlog for an existing repo, using a
 * cheap structural context (file list + README). Read-only: no branch, no git. The
 * resulting tasks are exactly what `runBacklog` consumes.
 */
export async function plan(
  profileName: string,
  goal: string,
  opts: PlanOptions = {}
): Promise<PlanResult> {
  if (!goal || !goal.trim()) throw new Error("Planner needs a non-empty goal.");

  const profile = loadProfile(profileName);
  const tracker =
    opts.tracker ?? new BudgetTracker(loadBudgetConfig(), new TokenLedger(), () => new Date());

  const paths = await listRepoFiles(profile, opts.maxFiles);
  const readmePath = path.join(profile.path, "README.md");
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf-8") : undefined;
  const cachedPrefix = renderPlanContext(paths, readme);

  const output = await runAgent(plannerAgent, { task: goal, history: [] }, 1, true, tracker, cachedPrefix);
  const tasks = parsePlannerOutput(output.output);
  if (tasks.length === 0) {
    throw new Error("Planner produced no tasks — try rephrasing the goal or check the model output.");
  }

  const snap = tracker.snapshot();
  return { tasks, tokens: { run: snap.runTokens, local: snap.localTokens } };
}
