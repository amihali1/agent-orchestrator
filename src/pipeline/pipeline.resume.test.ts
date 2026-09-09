import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./runner", () => ({ runAgent: vi.fn() }));

import { runPipeline, resumePipeline } from "./pipeline";
import { runAgent } from "./runner";
import { AgentConfig, AgentOutput } from "../types";
import { BudgetTracker } from "../budget/tracker";
import { TokenLedger } from "../budget/ledger";
import { CheckpointStore } from "../checkpoint/store";
import { BudgetExceededError } from "../budget/errors";

const mockRunAgent = vi.mocked(runAgent);

function agent(name: string): AgentConfig {
  return { name, systemPrompt: `You are ${name}.` };
}

describe("pause + resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Every step burns 1000 tokens (recorded into whichever tracker is passed).
    mockRunAgent.mockImplementation(async (a, _ctx, _att, _nm, tracker) => {
      tracker?.record({ inputTokens: 1000, outputTokens: 0 });
      const out: AgentOutput = { status: "success", output: `${a.name} out`, reasoning: "ok" };
      return out;
    });
  });

  it("checkpoints on budget pause, then resumes to completion without re-running done steps", async () => {
    const agents = [agent("designer"), agent("engineer"), agent("tester")];
    const store = new CheckpointStore(":memory:");

    // Cap 1500: designer (1000) passes, engineer (2000 total) trips the cap.
    const capped = new BudgetTracker(
      { maxTokensPerRun: 1500, maxTokensPerDay: 0 },
      new TokenLedger(":memory:")
    );

    let runId = "";
    await expect(
      runPipeline("build", { agents, tracker: capped, checkpoint: store })
    ).rejects.toMatchObject({ name: "BudgetExceededError" });

    const paused = store.listResumable();
    expect(paused).toHaveLength(1);
    runId = paused[0].runId;
    expect(paused[0].status).toBe("paused");
    expect(paused[0].currentIndex).toBe(2); // designer + engineer done, tester next
    expect(paused[0].history.map((h) => h.agentName)).toEqual(["designer", "engineer"]);
    expect(paused[0].runTokens).toBe(2000);

    // Resume with headroom — should run only the tester and finish.
    mockRunAgent.mockClear();
    const unlimited = new BudgetTracker(
      { maxTokensPerRun: 0, maxTokensPerDay: 0 },
      new TokenLedger(":memory:")
    );
    const results = await resumePipeline(runId, {
      agents,
      tracker: unlimited,
      checkpoint: store,
    });

    // Only the remaining step ran on resume.
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(mockRunAgent.mock.calls[0][0].name).toBe("tester");

    // Final history is the full pipeline, in order, no duplicates.
    expect(results.map((r) => r.agentName)).toEqual(["designer", "engineer", "tester"]);
    expect(store.get(runId)!.status).toBe("done");
  });

  it("throws BudgetExceededError from the capped run", async () => {
    const agents = [agent("designer"), agent("engineer")];
    const capped = new BudgetTracker(
      { maxTokensPerRun: 1500, maxTokensPerDay: 0 },
      new TokenLedger(":memory:")
    );
    await expect(
      runPipeline("x", { agents, tracker: capped, checkpoint: new CheckpointStore(":memory:") })
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
