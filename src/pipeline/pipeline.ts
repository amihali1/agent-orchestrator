import crypto from "crypto";
import { AgentConfig, AgentResult, PipelineContext, PipelineOptions } from "../types";
import { runAgent } from "./runner";
import { BudgetTracker } from "../budget/tracker";
import { TokenLedger } from "../budget/ledger";
import { loadBudgetConfig } from "../budget/config";
import { isPauseSignal } from "../budget/errors";
import { CheckpointStore, RunState } from "../checkpoint/store";

/** Start a fresh run. Returns the accumulated results (same shape as before). */
export async function runPipeline(
  task: string,
  options: PipelineOptions
): Promise<AgentResult[]> {
  const { agents, noMemory } = options;
  const now = new Date().toISOString();
  const state: RunState = {
    runId: crypto.randomUUID(),
    task,
    status: "running",
    currentIndex: 0,
    retryCounts: {},
    history: [],
    runTokens: 0,
    agentNames: agents.map((a) => a.name),
    noMemory: noMemory ?? false,
    createdAt: now,
    updatedAt: now,
  };
  return executeRun(state, options);
}

/** Resume a previously paused/interrupted run by id, re-binding the agent configs. */
export async function resumePipeline(
  runId: string,
  options: PipelineOptions
): Promise<AgentResult[]> {
  const store = options.checkpoint ?? new CheckpointStore();
  const state = store.get(runId);
  if (!state) throw new Error(`No run found with id "${runId}"`);
  if (state.status === "done") {
    console.log(`Run ${runId} already completed.`);
    return state.history;
  }
  // Re-bind saved agent names to the provided agent configs, preserving order.
  const byName = new Map(options.agents.map((a) => [a.name, a]));
  const agents = state.agentNames.map((name) => {
    const cfg = byName.get(name);
    if (!cfg) throw new Error(`Cannot resume: agent "${name}" not in provided agents`);
    return cfg;
  });
  console.log(
    `Resuming run ${runId} at step ${state.currentIndex}/${agents.length} ` +
      `(${state.runTokens} tokens used).`
  );
  return executeRun(state, { ...options, agents });
}

/**
 * Shared checkpoint-driven loop. State (index, retryCounts, history, tokens) lives
 * in `state` and is persisted after every step, so a pause or crash resumes cleanly.
 */
async function executeRun(state: RunState, options: PipelineOptions): Promise<AgentResult[]> {
  const { agents, onAgentComplete } = options;
  const store = options.checkpoint ?? new CheckpointStore();
  const tracker =
    options.tracker ??
    new BudgetTracker(
      loadBudgetConfig(),
      new TokenLedger(),
      () => new Date(),
      state.runTokens,
      state.localTokens ?? 0
    );

  const context: PipelineContext = { task: state.task, history: [...state.history] };
  const retryCounts = new Map<string, number>(Object.entries(state.retryCounts));

  state.status = "running";
  touch(state);
  store.save(state);

  let i = state.currentIndex;
  try {
    while (i < agents.length) {
      const agent = agents[i];
      const attempt = (retryCounts.get(agent.name) ?? 0) + 1;
      console.log(`\n[${agent.name.toUpperCase()}] Running (attempt ${attempt})...`);

      const output = await runAgent(agent, context, attempt, state.noMemory, tracker);

      const result: AgentResult = {
        ...output,
        agentName: agent.name,
        timestamp: new Date(),
        attempt,
      };
      context.history.push(result);
      onAgentComplete?.(result);

      // Decide the next index BEFORE persisting/checking budget, so a pause
      // checkpoints an already-advanced index and resume never re-runs this step.
      const nextIndex = advance(agents, agent, output, i, retryCounts);

      const b = tracker.snapshot();
      console.log(
        `  tokens: run ${b.runTokens}${b.maxRun ? "/" + b.maxRun : ""}` +
          ` · day ${b.dayTokens}${b.maxDay ? "/" + b.maxDay : ""}` +
          (b.localTokens ? ` · local ${b.localTokens}` : "")
      );

      // Persist the advanced state, then enforce caps (may throw a pause signal).
      state.currentIndex = nextIndex;
      state.retryCounts = Object.fromEntries(retryCounts);
      state.history = context.history;
      state.runTokens = b.runTokens;
      state.localTokens = b.localTokens;
      touch(state);
      store.save(state);

      tracker.assertWithinBudget();

      i = nextIndex;
    }

    state.status = "done";
    touch(state);
    store.save(state);
    return context.history;
  } catch (err) {
    // state.currentIndex already holds the correct resume point:
    //  - budget pause: advanced index was saved just before assertWithinBudget threw
    //  - 429 (mid-call): thrown before any mutation, so it still points at this step
    state.status = isPauseSignal(err) ? "paused" : "failed";
    state.pausedReason = err instanceof Error ? err.message : String(err);
    state.history = context.history;
    const errSnap = tracker.snapshot();
    state.runTokens = errSnap.runTokens;
    state.localTokens = errSnap.localTokens;
    touch(state);
    store.save(state);
    if (isPauseSignal(err)) (err as { runId?: string }).runId = state.runId;
    throw err;
  }
}

/** Compute the next pipeline index, mutating retryCounts for the revision/advance rules. */
function advance(
  agents: AgentConfig[],
  agent: AgentConfig,
  output: { status: string },
  i: number,
  retryCounts: Map<string, number>
): number {
  if (output.status === "needs_revision" && agent.onRevision) {
    const retryIndex = agents.findIndex((a) => a.name === agent.onRevision);
    if (retryIndex === -1) {
      throw new Error(`onRevision agent "${agent.onRevision}" not found in pipeline`);
    }
    const retryAgent = agents[retryIndex];
    const retryCount = retryCounts.get(retryAgent.name) ?? 0;
    const retryMax = retryAgent.maxRetries ?? 3;

    if (retryCount >= retryMax) {
      console.warn(
        `[${agent.name.toUpperCase()}] Max retries reached for "${retryAgent.name}", moving on.`
      );
      return i + 1;
    }
    console.log(`[${agent.name.toUpperCase()}] Requesting revision from "${agent.onRevision}"...`);
    retryCounts.set(retryAgent.name, retryCount + 1);
    return retryIndex;
  }
  retryCounts.set(agent.name, (retryCounts.get(agent.name) ?? 0) + 1);
  return i + 1;
}

function touch(state: RunState): void {
  state.updatedAt = new Date().toISOString();
}
