import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPipeline } from "./pipeline";
import { AgentConfig, AgentOutput, PipelineOptions } from "../types";
import { CheckpointStore } from "../checkpoint/store";

// Always inject an in-memory checkpoint store so tests never touch the on-disk
// checkpoints.db (which otherwise pollutes real run history / stats).
function run(task: string, opts: Omit<PipelineOptions, "checkpoint">) {
  return runPipeline(task, { ...opts, checkpoint: new CheckpointStore(":memory:") });
}

// Mock the runner module
vi.mock("./runner", () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from "./runner";
const mockRunAgent = vi.mocked(runAgent);

function makeAgent(overrides: Partial<AgentConfig> & { name: string }): AgentConfig {
  return {
    systemPrompt: `You are the ${overrides.name} agent.`,
    ...overrides,
  };
}

function successOutput(output: string, reasoning = "done"): AgentOutput {
  return { status: "success", output, reasoning };
}

function revisionOutput(feedback: string): AgentOutput {
  return { status: "needs_revision", output: "", feedback, reasoning: "needs work" };
}

describe("runPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("sequential execution", () => {
    it("runs all agents in order", async () => {
      const agents = [
        makeAgent({ name: "designer" }),
        makeAgent({ name: "engineer" }),
        makeAgent({ name: "tester" }),
      ];

      mockRunAgent
        .mockResolvedValueOnce(successOutput("design spec"))
        .mockResolvedValueOnce(successOutput("code"))
        .mockResolvedValueOnce(successOutput("tests"));

      const results = await run("build an app", { agents });

      expect(results).toHaveLength(3);
      expect(results[0].agentName).toBe("designer");
      expect(results[1].agentName).toBe("engineer");
      expect(results[2].agentName).toBe("tester");
    });

    it("passes task to each agent via context", async () => {
      const agents = [makeAgent({ name: "designer" })];
      mockRunAgent.mockResolvedValueOnce(successOutput("spec"));

      await run("my task", { agents });

      expect(mockRunAgent).toHaveBeenCalledWith(
        agents[0],
        expect.objectContaining({ task: "my task" }),
        1,
        false,
        expect.anything()
      );
    });

    it("calls agents sequentially and passes shared context", async () => {
      const agents = [
        makeAgent({ name: "designer" }),
        makeAgent({ name: "engineer" }),
      ];

      mockRunAgent
        .mockResolvedValueOnce(successOutput("spec"))
        .mockResolvedValueOnce(successOutput("code"));

      await run("task", { agents });

      // Both agents were called in order
      expect(mockRunAgent).toHaveBeenCalledTimes(2);
      expect(mockRunAgent.mock.calls[0][0].name).toBe("designer");
      expect(mockRunAgent.mock.calls[1][0].name).toBe("engineer");

      // Both received the same context object (shared reference)
      const ctx1 = mockRunAgent.mock.calls[0][1];
      const ctx2 = mockRunAgent.mock.calls[1][1];
      expect(ctx1).toBe(ctx2);
    });
  });

  describe("agent handoff and revision", () => {
    it("jumps back to the specified agent on revision", async () => {
      const agents = [
        makeAgent({ name: "engineer", maxRetries: 3 }),
        makeAgent({ name: "tester", onRevision: "engineer" }),
      ];

      mockRunAgent
        .mockResolvedValueOnce(successOutput("v1 code"))       // engineer attempt 1
        .mockResolvedValueOnce(revisionOutput("fix the bug"))   // tester rejects
        .mockResolvedValueOnce(successOutput("v2 code"))        // engineer attempt 2
        .mockResolvedValueOnce(successOutput("tests pass"));    // tester approves

      const results = await run("task", { agents });

      expect(results).toHaveLength(4);
      expect(results[0].agentName).toBe("engineer");
      expect(results[1].agentName).toBe("tester");
      expect(results[1].status).toBe("needs_revision");
      expect(results[2].agentName).toBe("engineer");
      expect(results[3].agentName).toBe("tester");
      expect(results[3].status).toBe("success");
    });

    it("respects maxRetries and moves on when exhausted", async () => {
      // maxRetries: 1 means engineer can be retried once.
      // But the initial run already sets retryCount=1 via the success path,
      // so the very first tester rejection triggers the max retry limit.
      const agents = [
        makeAgent({ name: "engineer", maxRetries: 1 }),
        makeAgent({ name: "tester", onRevision: "engineer" }),
      ];

      mockRunAgent
        .mockResolvedValueOnce(successOutput("v1"))        // engineer: attempt 1, sets retryCount=1
        .mockResolvedValueOnce(revisionOutput("fix it"));  // tester: rejects, retryCount(1) >= max(1) → moves on

      const results = await run("task", { agents });

      // Pipeline moves on after tester's first rejection since engineer hit max
      expect(results).toHaveLength(2);
      expect(results[0].agentName).toBe("engineer");
      expect(results[1].agentName).toBe("tester");
    });

    it("allows retries up to maxRetries before moving on", async () => {
      const agents = [
        makeAgent({ name: "engineer", maxRetries: 3 }),
        makeAgent({ name: "tester", onRevision: "engineer" }),
      ];

      // engineer(1) → success, retryCount=1
      // tester(1) → reject, retryCount=2, jump back
      // engineer(3) → success, retryCount=3
      // tester(1) → reject, retryCount=3 >= max(3) → moves on
      mockRunAgent
        .mockResolvedValueOnce(successOutput("v1"))
        .mockResolvedValueOnce(revisionOutput("needs work"))
        .mockResolvedValueOnce(successOutput("v2"))
        .mockResolvedValueOnce(revisionOutput("still bad"));

      const results = await run("task", { agents });

      expect(results).toHaveLength(4);
      // Pipeline exhausted retries and moved on
      expect(results[3].status).toBe("needs_revision");
    });

    it("throws when onRevision references a non-existent agent", async () => {
      const agents = [
        makeAgent({ name: "engineer" }),
        makeAgent({ name: "tester", onRevision: "nonexistent" }),
      ];

      mockRunAgent
        .mockResolvedValueOnce(successOutput("code"))
        .mockResolvedValueOnce(revisionOutput("fix it"));

      await expect(run("task", { agents })).rejects.toThrow(
        'onRevision agent "nonexistent" not found'
      );
    });

    it("moves forward when needs_revision but no onRevision configured", async () => {
      const agents = [
        makeAgent({ name: "designer" }),
        makeAgent({ name: "engineer" }), // no onRevision
      ];

      mockRunAgent
        .mockResolvedValueOnce(successOutput("spec"))
        .mockResolvedValueOnce({ status: "needs_revision", output: "", feedback: "hmm", reasoning: "unsure" });

      const results = await run("task", { agents });

      expect(results).toHaveLength(2);
      // Moves on since no onRevision
    });
  });

  describe("noMemory flag", () => {
    it("passes noMemory=true to runAgent when set", async () => {
      const agents = [makeAgent({ name: "designer" })];
      mockRunAgent.mockResolvedValueOnce(successOutput("spec"));

      await run("task", { agents, noMemory: true });

      expect(mockRunAgent).toHaveBeenCalledWith(
        agents[0],
        expect.anything(),
        1,
        true,
        expect.anything()
      );
    });

    it("normalizes unset noMemory to false", async () => {
      const agents = [makeAgent({ name: "designer" })];
      mockRunAgent.mockResolvedValueOnce(successOutput("spec"));

      await run("task", { agents });

      expect(mockRunAgent).toHaveBeenCalledWith(
        agents[0],
        expect.anything(),
        1,
        false,
        expect.anything()
      );
    });
  });

  describe("onAgentComplete callback", () => {
    it("calls onAgentComplete after each agent finishes", async () => {
      const agents = [
        makeAgent({ name: "designer" }),
        makeAgent({ name: "engineer" }),
      ];

      mockRunAgent
        .mockResolvedValueOnce(successOutput("spec"))
        .mockResolvedValueOnce(successOutput("code"));

      const completedAgents: string[] = [];
      await run("task", {
        agents,
        onAgentComplete: (result) => completedAgents.push(result.agentName),
      });

      expect(completedAgents).toEqual(["designer", "engineer"]);
    });
  });

  describe("result metadata", () => {
    it("includes agentName, timestamp, and attempt in results", async () => {
      const agents = [makeAgent({ name: "designer" })];
      mockRunAgent.mockResolvedValueOnce(successOutput("spec"));

      const results = await run("task", { agents });

      expect(results[0].agentName).toBe("designer");
      expect(results[0].timestamp).toBeInstanceOf(Date);
      expect(results[0].attempt).toBe(1);
    });

    it("tracks attempt count across revisions", async () => {
      const agents = [
        makeAgent({ name: "engineer", maxRetries: 3 }),
        makeAgent({ name: "tester", onRevision: "engineer" }),
      ];

      mockRunAgent
        .mockResolvedValueOnce(successOutput("v1"))
        .mockResolvedValueOnce(revisionOutput("fix"))
        .mockResolvedValueOnce(successOutput("v2"))
        .mockResolvedValueOnce(successOutput("pass"));

      const results = await run("task", { agents });

      expect(results[0].agentName).toBe("engineer");
      expect(results[0].attempt).toBe(1);
      // After revision, engineer runs again with incremented attempt
      expect(results[2].agentName).toBe("engineer");
      expect(results[2].attempt).toBe(3); // retryCount was bumped to 2, so attempt = 2+1=3
    });
  });
});
