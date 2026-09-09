import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentConfig, AgentResult, PipelineContext } from "../types";

const { mockCreate, mockRecall, mockSave } = vi.hoisted(() => {
  return {
    mockCreate: vi.fn(),
    mockRecall: vi.fn().mockReturnValue([]),
    mockSave: vi.fn(),
  };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

vi.mock("../memory/store", () => ({
  MemoryStore: class MockMemoryStore {
    recall = mockRecall;
    save = mockSave;
  },
}));

import { runAgent, truncateForInjection } from "./runner";

function makeAgent(name = "engineer"): AgentConfig {
  return { name, systemPrompt: `You are the ${name}.` };
}

function makeContext(task = "build something", history: AgentResult[] = []): PipelineContext {
  return { task, history };
}

function toolUseResponse(input: Record<string, unknown>) {
  return {
    content: [
      { type: "tool_use", name: "submit_output", input },
    ],
  };
}

function textResponse(text: string) {
  return {
    content: [
      { type: "text", text },
    ],
  };
}

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecall.mockReturnValue([]);
    // Route the smart tier through the (mocked) Anthropic SDK, not the real
    // Claude Agent SDK which would spawn the CLI.
    process.env.SMART_PROVIDER = "api";
  });

  describe("output extraction", () => {
    it("extracts output from tool_use response", async () => {
      mockCreate.mockResolvedValueOnce(
        toolUseResponse({
          status: "success",
          output: "implemented code",
          reasoning: "used best practices",
        })
      );

      const result = await runAgent(makeAgent(), makeContext(), 1);

      expect(result.status).toBe("success");
      expect(result.output).toBe("implemented code");
      expect(result.reasoning).toBe("used best practices");
    });

    it("extracts needs_revision status with feedback", async () => {
      mockCreate.mockResolvedValueOnce(
        toolUseResponse({
          status: "needs_revision",
          output: "",
          reasoning: "code has bugs",
          feedback: "fix the null check on line 42",
        })
      );

      const result = await runAgent(makeAgent(), makeContext(), 1);

      expect(result.status).toBe("needs_revision");
      expect(result.feedback).toBe("fix the null check on line 42");
    });

    it("falls back to text-only response as success", async () => {
      mockCreate.mockResolvedValueOnce(textResponse("here is my analysis..."));

      const result = await runAgent(makeAgent(), makeContext(), 1);

      expect(result.status).toBe("success");
      expect(result.output).toBe("here is my analysis...");
      expect(result.reasoning).toBe("");
    });

    it("uses text content as fallback when tool output is empty", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "detailed analysis here" },
          {
            type: "tool_use",
            name: "submit_output",
            input: { status: "success", output: "", reasoning: "done" },
          },
        ],
      });

      const result = await runAgent(makeAgent(), makeContext(), 1);

      expect(result.output).toBe("detailed analysis here");
    });
  });

  describe("memory integration", () => {
    it("recalls memories when noMemory is false", async () => {
      mockRecall.mockReturnValue([
        {
          id: "1",
          agent_name: "engineer",
          input_hash: "abc",
          task: "previous task",
          output: "previous output",
          reasoning: "previous reasoning",
          created_at: "2024-01-01T00:00:00.000Z",
        },
      ]);

      mockCreate.mockResolvedValueOnce(
        toolUseResponse({ status: "success", output: "code", reasoning: "done" })
      );

      await runAgent(makeAgent(), makeContext(), 1, false);

      expect(mockRecall).toHaveBeenCalledWith("engineer", "build something", 2);
      // The user message sent to Claude should contain the memory
      const createCall = mockCreate.mock.calls[0][0];
      const userMessage = createCall.messages[0].content;
      expect(userMessage).toContain("Relevant Past Decisions");
      expect(userMessage).toContain("previous output");
    });

    it("skips memory recall when noMemory is true", async () => {
      mockCreate.mockResolvedValueOnce(
        toolUseResponse({ status: "success", output: "code", reasoning: "done" })
      );

      await runAgent(makeAgent(), makeContext(), 1, true);

      expect(mockRecall).not.toHaveBeenCalled();
      // User message should NOT contain memory section
      const createCall = mockCreate.mock.calls[0][0];
      const userMessage = createCall.messages[0].content;
      expect(userMessage).not.toContain("Relevant Past Decisions");
    });

    it("saves successful output to memory", async () => {
      mockCreate.mockResolvedValueOnce(
        toolUseResponse({
          status: "success",
          output: "great code",
          reasoning: "well structured",
        })
      );

      await runAgent(makeAgent(), makeContext("build auth"), 1);

      expect(mockSave).toHaveBeenCalledWith(
        "engineer",
        "build auth",
        "great code",
        "well structured"
      );
    });

    it("does not save to memory when status is needs_revision", async () => {
      mockCreate.mockResolvedValueOnce(
        toolUseResponse({
          status: "needs_revision",
          output: "",
          reasoning: "bad code",
          feedback: "redo it",
        })
      );

      await runAgent(makeAgent(), makeContext(), 1);

      expect(mockSave).not.toHaveBeenCalled();
    });

    it("does not save to memory when output is empty", async () => {
      mockCreate.mockResolvedValueOnce(
        toolUseResponse({
          status: "success",
          output: "",
          reasoning: "done",
        })
      );

      await runAgent(makeAgent(), makeContext(), 1);

      expect(mockSave).not.toHaveBeenCalled();
    });

    it("does not save to memory when reasoning is empty", async () => {
      mockCreate.mockResolvedValueOnce(
        toolUseResponse({
          status: "success",
          output: "some output",
          reasoning: "",
        })
      );

      await runAgent(makeAgent(), makeContext(), 1);

      expect(mockSave).not.toHaveBeenCalled();
    });
  });

  describe("message construction", () => {
    it("includes task in user message", async () => {
      mockCreate.mockResolvedValueOnce(
        toolUseResponse({ status: "success", output: "x", reasoning: "y" })
      );

      await runAgent(makeAgent(), makeContext("create a REST API"), 1);

      const msg = mockCreate.mock.calls[0][0].messages[0].content;
      expect(msg).toContain("# Task\ncreate a REST API");
    });

    it("includes previous agent output in message", async () => {
      const history: AgentResult[] = [
        {
          agentName: "designer",
          status: "success",
          output: "design spec here",
          reasoning: "designed it",
          timestamp: new Date(),
          attempt: 1,
        },
      ];

      mockCreate.mockResolvedValueOnce(
        toolUseResponse({ status: "success", output: "x", reasoning: "y" })
      );

      await runAgent(makeAgent(), makeContext("task", history), 1);

      const msg = mockCreate.mock.calls[0][0].messages[0].content;
      expect(msg).toContain("Input from designer");
      expect(msg).toContain("design spec here");
    });

    it("includes revision feedback in message when present", async () => {
      const history: AgentResult[] = [
        {
          agentName: "tester",
          status: "needs_revision",
          output: "test results",
          feedback: "fix the null pointer on line 10",
          reasoning: "tests failed",
          timestamp: new Date(),
          attempt: 1,
        },
      ];

      mockCreate.mockResolvedValueOnce(
        toolUseResponse({ status: "success", output: "x", reasoning: "y" })
      );

      await runAgent(makeAgent(), makeContext("task", history), 1);

      const msg = mockCreate.mock.calls[0][0].messages[0].content;
      expect(msg).toContain("Revision Feedback");
      expect(msg).toContain("fix the null pointer on line 10");
    });

    it("sends correct model and system prompt to API", async () => {
      mockCreate.mockResolvedValueOnce(
        toolUseResponse({ status: "success", output: "x", reasoning: "y" })
      );

      const agent = makeAgent("reviewer");
      await runAgent(agent, makeContext(), 1);

      const call = mockCreate.mock.calls[0][0];
      expect(call.model).toBe("claude-opus-4-8");
      expect(call.system).toBe("You are the reviewer.");
      expect(call.max_tokens).toBe(16384);
    });
  });

  describe("memory injection trimming", () => {
    it("truncates a long recalled memory in the user message", async () => {
      const huge = "X".repeat(5000);
      mockRecall.mockReturnValue([
        {
          id: "1",
          agent_name: "engineer",
          input_hash: "abc",
          task: "prev",
          output: huge,
          reasoning: "r",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ]);
      mockCreate.mockResolvedValueOnce(
        toolUseResponse({ status: "success", output: "code", reasoning: "done" })
      );

      await runAgent(makeAgent(), makeContext(), 1, false);

      const userMessage = mockCreate.mock.calls[0][0].messages[0].content;
      expect(userMessage).not.toContain(huge); // full 5000-char blob not injected
      expect(userMessage).toContain("truncated");
    });
  });
});

describe("truncateForInjection", () => {
  it("returns text unchanged when under the cap", () => {
    expect(truncateForInjection("short", 100)).toBe("short");
  });

  it("truncates and annotates when over the cap", () => {
    const out = truncateForInjection("abcdefghij", 4);
    expect(out.startsWith("abcd")).toBe(true);
    expect(out).toContain("truncated 6 chars");
  });
});
