import crypto from "crypto";
import { AgentResult, PipelineContext } from "../types";
import { runAgent } from "../pipeline/runner";
import { BudgetTracker } from "../budget/tracker";
import { TokenLedger } from "../budget/ledger";
import { loadBudgetConfig } from "../budget/config";
import { isPauseSignal } from "../budget/errors";
import { CheckpointStore, RunState } from "../checkpoint/store";
import { extractFiles, extractFencedBlock, extractBareFile } from "../files";
import { loadProfile, ProjectProfile } from "./profile";
import { gatherContext, renderContext } from "./gather";
import { assertCleanRepo, createBranch, checkoutBranch, applyFiles, commitAll } from "./apply";
import { verify, formatFailures } from "./verifier";
import { workspaceEngineer } from "./agents";

export interface WorkspaceOptions {
  /** Files/globs the engineer edits (relative to repo). Falls back to profile.contextGlobs. */
  files?: string[];
  /** Apply + verify but never commit. */
  dryRun?: boolean;
  maxIterations?: number;
  tracker?: BudgetTracker;
  checkpoint?: CheckpointStore;
}

export interface WorkspaceResult {
  ok: boolean;
  runId: string;
  branch: string;
  iterations: number;
  committed: boolean;
  commit?: string;
  written: string[];
  failureSummary?: string;
}

const MAX_ITERATIONS = 3;

/** Start a fresh workspace run: clean-tree check → branch → edit/verify loop. */
export async function runWorkspace(
  profileName: string,
  task: string,
  opts: WorkspaceOptions = {}
): Promise<WorkspaceResult> {
  const profile = loadProfile(profileName);
  assertCleanRepo(profile.path);
  const branch = createBranch(profile.path, task);
  console.log(`\nWorkspace: ${profile.name} @ ${profile.path}\nBranch: ${branch}`);

  const now = new Date().toISOString();
  const state: RunState = {
    runId: crypto.randomUUID(),
    task,
    status: "running",
    currentIndex: 0,
    retryCounts: {},
    history: [],
    runTokens: 0,
    agentNames: ["engineer"],
    noMemory: true,
    projectName: profileName,
    branch,
    iteration: 0,
    createdAt: now,
    updatedAt: now,
  };
  return executeWorkspace(profile, state, opts);
}

/** Resume a paused/interrupted workspace run on its existing branch. */
export async function resumeWorkspace(
  runId: string,
  opts: WorkspaceOptions = {}
): Promise<WorkspaceResult> {
  const store = opts.checkpoint ?? new CheckpointStore();
  const state = store.get(runId);
  if (!state) throw new Error(`No run found with id "${runId}"`);
  if (!state.projectName || !state.branch) throw new Error(`Run ${runId} is not a workspace run`);
  if (state.status === "done") {
    console.log(`Run ${runId} already completed.`);
    return { ok: true, runId, branch: state.branch, iterations: state.iteration ?? 0, committed: true, written: [] };
  }
  const profile = loadProfile(state.projectName);
  checkoutBranch(profile.path, state.branch);
  console.log(`Resuming workspace run ${runId} on ${state.branch} at iteration ${state.iteration}.`);
  return executeWorkspace(profile, state, { ...opts, checkpoint: store });
}

async function executeWorkspace(
  profile: ProjectProfile,
  state: RunState,
  opts: WorkspaceOptions
): Promise<WorkspaceResult> {
  const store = opts.checkpoint ?? new CheckpointStore();
  const tracker =
    opts.tracker ??
    new BudgetTracker(loadBudgetConfig(), new TokenLedger(), () => new Date(), state.runTokens);
  const maxIter = opts.maxIterations ?? MAX_ITERATIONS;
  const branch = state.branch!;

  state.status = "running";
  state.updatedAt = new Date().toISOString();
  store.save(state);

  let feedback = "";
  let written: string[] = [];
  const ctx: PipelineContext = { task: state.task, history: [...state.history] };

  try {
    for (let iter = state.iteration ?? 0; iter < maxIter; iter++) {
      state.iteration = iter;
      console.log(`\n[ITERATION ${iter + 1}/${maxIter}]`);

      // Re-gather each iteration so the engineer sees its own applied edits.
      const gathered = await gatherContext(profile, opts.files);
      const cachedPrefix = renderContext(gathered);

      // Carry verifier failures forward as revision feedback (buildUserMessage reads
      // the last history entry's feedback).
      const engineerCtx: PipelineContext = feedback
        ? {
            task: ctx.task,
            history: [
              ...ctx.history,
              feedbackEntry(feedback, iter),
            ],
          }
        : ctx;

      const output = await runAgent(workspaceEngineer, engineerCtx, iter + 1, true, tracker, cachedPrefix);
      const result: AgentResult = {
        ...output,
        agentName: "engineer",
        timestamp: new Date(),
        attempt: iter + 1,
      };
      ctx.history.push(result);

      const files = extractFiles(output.output);
      // Fallback: single known target + a bare fenced block (common with small local
      // models that skip the `## File:` header) → map the block to that one file.
      if (files.size === 0 && gathered.length === 1) {
        const block = extractFencedBlock(output.output) ?? extractBareFile(output.output);
        if (block) files.set(gathered[0].path, block);
      }
      if (files.size === 0) {
        throw new Error("Engineer produced no `## File:` blocks — cannot apply changes.");
      }
      written = applyFiles(profile.path, files);
      console.log(`  applied ${written.length} file(s): ${written.join(", ")}`);

      // Persist progress, then enforce budget (may pause here).
      state.runTokens = tracker.snapshot().runTokens;
      state.history = ctx.history;
      state.updatedAt = new Date().toISOString();
      store.save(state);
      tracker.assertWithinBudget();

      const v = verify(profile);
      if (v.ok) {
        let commit: string | undefined;
        if (!opts.dryRun) {
          commit = commitAll(profile.path, `agent: ${state.task}`);
          console.log(`  ✓ gates green — committed ${commit} on ${branch}`);
        } else {
          console.log(`  ✓ gates green — dry-run, not committing`);
        }
        state.status = "done";
        state.updatedAt = new Date().toISOString();
        store.save(state);
        return { ok: true, runId: state.runId, branch, iterations: iter + 1, committed: !opts.dryRun, commit, written };
      }

      feedback = formatFailures(v);
      console.log(`  ✗ gates failed (${v.gates.filter((g) => !g.ok).map((g) => g.gate).join(", ")}) — retrying`);
    }

    state.status = "failed";
    state.pausedReason = "verifier still failing after max iterations";
    state.updatedAt = new Date().toISOString();
    store.save(state);
    return { ok: false, runId: state.runId, branch, iterations: maxIter, committed: false, written, failureSummary: feedback };
  } catch (err) {
    state.status = isPauseSignal(err) ? "paused" : "failed";
    state.pausedReason = err instanceof Error ? err.message : String(err);
    state.runTokens = tracker.snapshot().runTokens;
    state.history = ctx.history;
    state.updatedAt = new Date().toISOString();
    store.save(state);
    if (isPauseSignal(err)) (err as { runId?: string }).runId = state.runId;
    throw err;
  }
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
