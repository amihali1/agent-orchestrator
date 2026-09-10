import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../pipeline/runner", () => ({ runAgent: vi.fn() }));
vi.mock("./profile", () => ({
  loadProfile: vi.fn(() => ({
    name: "p",
    path: "/tmp/repo",
    stack: "x",
    commands: { typecheck: null, lint: null, test: null, e2e: null },
    contextGlobs: [],
  })),
}));
vi.mock("./gather", () => ({
  listRepoFiles: vi.fn(async () => ["src/a.ts", "src/b.ts"]),
  renderPlanContext: vi.fn(() => "PLAN_CONTEXT"),
}));

import { runAgent } from "../pipeline/runner";
import { plan } from "./planner";
import { plannerAgent } from "./agents";
import { BudgetTracker } from "../budget/tracker";
import { TokenLedger } from "../budget/ledger";
import { AgentOutput } from "../types";

const mockRunAgent = vi.mocked(runAgent);

function tracker() {
  return new BudgetTracker({ maxTokensPerRun: 0, maxTokensPerDay: 0 }, new TokenLedger(":memory:"));
}

function output(o: string): AgentOutput {
  return { status: "success", output: o, reasoning: "r" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("plan", () => {
  it("returns the parsed task list from a JSON-array planner output", async () => {
    mockRunAgent.mockResolvedValue(output('["task one", "task two", "task three"]'));

    const r = await plan("p", "add a feature", { tracker: tracker() });

    expect(r.tasks).toEqual(["task one", "task two", "task three"]);
    expect(r.tokens).toEqual({ run: 0, local: 0 });
    // Planner agent invoked with the goal and the rendered plan context as cached prefix.
    const call = mockRunAgent.mock.calls[0];
    expect(call[0]).toBe(plannerAgent);
    expect(call[1]).toMatchObject({ task: "add a feature" });
    expect(call[5]).toBe("PLAN_CONTEXT");
  });

  it("falls back to a markdown checklist output", async () => {
    mockRunAgent.mockResolvedValue(output("Plan:\n- do X\n- do Y"));
    const r = await plan("p", "goal", { tracker: tracker() });
    expect(r.tasks).toEqual(["do X", "do Y"]);
  });

  it("throws when the planner produces no tasks", async () => {
    mockRunAgent.mockResolvedValue(output("I could not determine any tasks."));
    await expect(plan("p", "goal", { tracker: tracker() })).rejects.toThrow(/no tasks/i);
  });

  it("throws on an empty goal before calling the model", async () => {
    await expect(plan("p", "   ", { tracker: tracker() })).rejects.toThrow(/non-empty goal/);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});
