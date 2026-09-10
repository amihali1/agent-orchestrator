import crypto from "crypto";
import { BudgetTracker } from "../budget/tracker";
import { TokenLedger } from "../budget/ledger";
import { loadBudgetConfig } from "../budget/config";
import { isPauseSignal } from "../budget/errors";
import { CheckpointStore, RunState } from "../checkpoint/store";
import { loadProfile, ProjectProfile } from "./profile";
import { assertCleanRepo, createBranch, checkoutBranch } from "./apply";
import { executeTask } from "./task";

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
  /** Token usage for the run: billable Claude tokens and free local (Ollama) tokens. */
  tokens: { run: number; local: number };
}

/** Start a fresh workspace run: clean-tree check → branch → single-task edit/verify loop. */
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
    localTokens: 0,
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
    return {
      ok: true,
      runId,
      branch: state.branch,
      iterations: state.iteration ?? 0,
      committed: true,
      written: [],
      tokens: { run: state.runTokens, local: state.localTokens ?? 0 },
    };
  }
  const profile = loadProfile(state.projectName);
  checkoutBranch(profile.path, state.branch);
  console.log(`Resuming workspace run ${runId} on ${state.branch}.`);
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
    new BudgetTracker(
      loadBudgetConfig(),
      new TokenLedger(),
      () => new Date(),
      state.runTokens,
      state.localTokens ?? 0
    );
  const branch = state.branch!;

  state.status = "running";
  state.updatedAt = new Date().toISOString();
  store.save(state);

  try {
    const result = await executeTask(profile, state.task, tracker, {
      files: opts.files,
      dryRun: opts.dryRun,
      maxIterations: opts.maxIterations,
    });

    const snap = tracker.snapshot();
    state.runTokens = snap.runTokens;
    state.localTokens = snap.localTokens;
    state.iteration = result.iterations;
    state.status = result.ok ? "done" : "failed";
    if (!result.ok) state.pausedReason = "verifier still failing after max iterations";
    state.updatedAt = new Date().toISOString();
    store.save(state);

    if (result.ok) {
      console.log(`  ${opts.dryRun ? "dry-run" : "committed " + result.commit} on ${branch}`);
    }
    return {
      ok: result.ok,
      runId: state.runId,
      branch,
      iterations: result.iterations,
      committed: result.ok && !opts.dryRun,
      commit: result.commit,
      written: result.written,
      failureSummary: result.failureSummary,
      tokens: { run: snap.runTokens, local: snap.localTokens },
    };
  } catch (err) {
    state.status = isPauseSignal(err) ? "paused" : "failed";
    state.pausedReason = err instanceof Error ? err.message : String(err);
    const snap = tracker.snapshot();
    state.runTokens = snap.runTokens;
    state.localTokens = snap.localTokens;
    state.updatedAt = new Date().toISOString();
    store.save(state);
    if (isPauseSignal(err)) (err as { runId?: string }).runId = state.runId;
    throw err;
  }
}
