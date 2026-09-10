import { AgentResult, PipelineContext } from "../types";
import { runAgent } from "../pipeline/runner";
import { BudgetTracker } from "../budget/tracker";
import { extractFiles, extractFencedBlock, extractBareFile } from "../files";
import { ProjectProfile } from "./profile";
import { gatherContext, renderContext } from "./gather";
import { applyFiles, commitAll } from "./apply";
import { verify, formatFailures } from "./verifier";
import { workspaceEngineer } from "./agents";

const DEFAULT_MAX_ITERATIONS = 3;

export interface ExecuteTaskOptions {
  /** Files/globs the engineer edits (relative to repo). Falls back to profile.contextGlobs. */
  files?: string[];
  /** Apply + verify but never commit. */
  dryRun?: boolean;
  maxIterations?: number;
  /** Commit message for the green commit (defaults to `agent: <task>`). */
  commitMessage?: string;
}

export interface TaskResult {
  ok: boolean;
  written: string[];
  commit?: string;
  failureSummary?: string;
  iterations: number;
}

/**
 * Run ONE task to green on the CURRENT branch: gather → engineer → apply → verify,
 * retrying with verifier feedback up to maxIterations, committing on green (unless
 * dryRun). Assumes the branch already exists — it does not create branches or check
 * the tree (the caller owns that).
 *
 * Tokens are recorded via `tracker`; the budget is asserted after each applied
 * iteration. A budget pause (BudgetExceededError) propagates to the caller, which
 * owns checkpointing/resume — this function never swallows it.
 */
export async function executeTask(
  profile: ProjectProfile,
  task: string,
  tracker: BudgetTracker,
  opts: ExecuteTaskOptions = {}
): Promise<TaskResult> {
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const ctx: PipelineContext = { task, history: [] };
  let feedback = "";
  let written: string[] = [];

  for (let iter = 0; iter < maxIter; iter++) {
    // Re-gather each iteration so the engineer sees its own applied edits.
    const gathered = await gatherContext(profile, opts.files);
    const cachedPrefix = renderContext(gathered);

    const engineerCtx: PipelineContext = feedback
      ? { task, history: [...ctx.history, feedbackEntry(feedback, iter)] }
      : ctx;

    const output = await runAgent(workspaceEngineer, engineerCtx, iter + 1, true, tracker, cachedPrefix);
    ctx.history.push({ ...output, agentName: "engineer", timestamp: new Date(), attempt: iter + 1 });

    const files = extractFiles(output.output);
    // Fallback for small local models that skip the `## File:` header when only one
    // target file is in play: a fenced block, or the whole bare output.
    if (files.size === 0 && gathered.length === 1) {
      const block = extractFencedBlock(output.output) ?? extractBareFile(output.output);
      if (block) files.set(gathered[0].path, block);
    }
    if (files.size === 0) {
      throw new Error("Engineer produced no `## File:` blocks — cannot apply changes.");
    }

    written = applyFiles(profile.path, files);
    console.log(`  applied ${written.length} file(s): ${written.join(", ")}`);

    // Enforce the budget after the edit is on disk (may throw a pause signal).
    tracker.assertWithinBudget();

    const v = verify(profile);
    if (v.ok) {
      let commit: string | undefined;
      if (!opts.dryRun) {
        commit = commitAll(profile.path, opts.commitMessage ?? `agent: ${task}`);
        console.log(`  ✓ gates green — committed ${commit}`);
      } else {
        console.log(`  ✓ gates green — dry-run, not committing`);
      }
      return { ok: true, written, commit, iterations: iter + 1 };
    }

    feedback = formatFailures(v);
    console.log(`  ✗ gates failed (${v.gates.filter((g) => !g.ok).map((g) => g.gate).join(", ")}) — retrying`);
  }

  return { ok: false, written, failureSummary: feedback, iterations: maxIter };
}

function feedbackEntry(feedback: string, iter: number): AgentResult {
  return {
    agentName: "verifier",
    status: "needs_revision",
    output: "",
    feedback,
    reasoning: "",
    timestamp: new Date(),
    attempt: iter,
  };
}
