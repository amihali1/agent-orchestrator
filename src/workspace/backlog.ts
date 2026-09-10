import crypto from "crypto";
import { BudgetTracker } from "../budget/tracker";
import { TokenLedger } from "../budget/ledger";
import { loadBudgetConfig } from "../budget/config";
import { isPauseSignal } from "../budget/errors";
import { BacklogStore, BacklogState, TaskOutcome } from "../checkpoint/backlog-store";
import { loadProfile, ProjectProfile } from "./profile";
import { assertCleanRepo, createBranch, checkoutBranch, resetHard } from "./apply";
import { executeTask } from "./task";

export interface BacklogOptions {
  /** Apply + verify but never commit. */
  dryRun?: boolean;
  maxIterations?: number;
  tracker?: BudgetTracker;
  store?: BacklogStore;
}

export interface BacklogResult {
  ok: boolean;
  backlogId: string;
  branch: string;
  tasks: TaskOutcome[];
  /** Number of tasks committed on the branch. */
  committed: number;
  tokens: { run: number; local: number };
  /** Set when the run halted: the task that failed its gate. */
  failedTask?: string;
}

/**
 * Run an ordered list of tasks on ONE branch: each task goes through the single-task
 * edit/verify loop and commits on green; later tasks re-gather and see earlier edits.
 * Halts on the first task that can't pass its gate (branch + prior commits left for
 * inspection). Budget pauses checkpoint and are resumable via `resumeBacklog`.
 */
export async function runBacklog(
  profileName: string,
  tasks: string[],
  opts: BacklogOptions = {}
): Promise<BacklogResult> {
  if (tasks.length === 0) throw new Error("Backlog is empty — provide at least one task.");
  const profile = loadProfile(profileName);
  assertCleanRepo(profile.path);
  const branch = createBranch(profile.path, `backlog ${tasks.length} tasks`);
  console.log(`\nBacklog: ${profile.name} @ ${profile.path}\nBranch: ${branch}\nTasks: ${tasks.length}`);

  const now = new Date().toISOString();
  const state: BacklogState = {
    backlogId: crypto.randomUUID(),
    projectName: profileName,
    branch,
    status: "running",
    tasks: tasks.map((t) => ({ task: t, status: "pending" as const })),
    currentIndex: 0,
    runTokens: 0,
    localTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
  return executeBacklog(profile, state, opts);
}

/** Resume a paused/interrupted backlog run on its existing branch. */
export async function resumeBacklog(
  backlogId: string,
  opts: BacklogOptions = {}
): Promise<BacklogResult> {
  const store = opts.store ?? new BacklogStore();
  const state = store.get(backlogId);
  if (!state) throw new Error(`No backlog run found with id "${backlogId}"`);
  if (state.status === "done") {
    console.log(`Backlog ${backlogId} already completed.`);
    return { ...resultBase(state), ok: true };
  }
  const profile = loadProfile(state.projectName);
  checkoutBranch(profile.path, state.branch);
  resetHard(profile.path); // drop partial edits from a task that was interrupted mid-flight
  console.log(
    `Resuming backlog ${backlogId} on ${state.branch} at task ${state.currentIndex + 1}/${state.tasks.length}.`
  );
  return executeBacklog(profile, state, { ...opts, store });
}

/** Exported for testing. Drives the task loop over an already-branched repo. */
export async function executeBacklog(
  profile: ProjectProfile,
  state: BacklogState,
  opts: BacklogOptions
): Promise<BacklogResult> {
  const store = opts.store ?? new BacklogStore();
  const tracker =
    opts.tracker ??
    new BudgetTracker(
      loadBudgetConfig(),
      new TokenLedger(),
      () => new Date(),
      state.runTokens,
      state.localTokens
    );

  state.status = "running";
  state.updatedAt = new Date().toISOString();
  store.save(state);

  try {
    for (let i = state.currentIndex; i < state.tasks.length; i++) {
      state.currentIndex = i;
      const task = state.tasks[i].task;
      console.log(`\n[TASK ${i + 1}/${state.tasks.length}] ${task}`);

      const result = await executeTask(profile, task, tracker, {
        dryRun: opts.dryRun,
        maxIterations: opts.maxIterations,
      });

      const snap = tracker.snapshot();
      state.runTokens = snap.runTokens;
      state.localTokens = snap.localTokens;

      if (!result.ok) {
        state.tasks[i].status = "failed";
        state.status = "failed";
        state.pausedReason = `task ${i + 1} failed its gate after ${result.iterations} iteration(s)`;
        state.updatedAt = new Date().toISOString();
        store.save(state);
        console.log(`\n✗ Halting: task ${i + 1} failed its gate. Branch ${state.branch} left for inspection.`);
        return { ...resultBase(state), ok: false, failedTask: task };
      }

      state.tasks[i] = { task, status: "done", commit: result.commit };
      state.currentIndex = i + 1;
      state.updatedAt = new Date().toISOString();
      store.save(state);

      // Enforce the budget between tasks so a pause resumes cleanly at the next one.
      tracker.assertWithinBudget();
    }

    state.status = "done";
    state.updatedAt = new Date().toISOString();
    store.save(state);
    return { ...resultBase(state), ok: true };
  } catch (err) {
    state.status = isPauseSignal(err) ? "paused" : "failed";
    state.pausedReason = err instanceof Error ? err.message : String(err);
    const snap = tracker.snapshot();
    state.runTokens = snap.runTokens;
    state.localTokens = snap.localTokens;
    state.updatedAt = new Date().toISOString();
    store.save(state);
    // Carry the backlog id as `runId` so withAutoResume can call resumeBacklog(id).
    if (isPauseSignal(err)) (err as { runId?: string }).runId = state.backlogId;
    throw err;
  }
}

function resultBase(state: BacklogState): Omit<BacklogResult, "ok" | "failedTask"> {
  return {
    backlogId: state.backlogId,
    branch: state.branch,
    tasks: state.tasks,
    committed: state.tasks.filter((t) => t.status === "done" && t.commit).length,
    tokens: { run: state.runTokens, local: state.localTokens },
  };
}
