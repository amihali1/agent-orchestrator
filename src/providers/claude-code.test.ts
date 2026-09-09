import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

import { ClaudeCodeProvider } from "./claude-code";
import { RateLimitError } from "../budget/errors";

function stream(messages: unknown[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}
function throwingStream(err: Error) {
  return (async function* () {
    throw err;
  })();
}
function successResult(result: string, usage = { input_tokens: 10, output_tokens: 5 }) {
  return { type: "result", subtype: "success", result, usage };
}

const req = { system: "sys", userMessage: "do it", maxTokens: 1000 };

describe("ClaudeCodeProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses a JSON result and maps usage", async () => {
    mockQuery.mockReturnValue(
      stream([
        successResult('{"status":"needs_revision","output":"","reasoning":"bug","feedback":"fix"}', {
          input_tokens: 100,
          output_tokens: 20,
        }),
      ])
    );
    const { output, usage, provider } = await new ClaudeCodeProvider("opus").complete(req);
    expect(output.status).toBe("needs_revision");
    expect(output.feedback).toBe("fix");
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(provider).toBe("claude-code");
  });

  it("falls back to raw text when the result is not JSON", async () => {
    mockQuery.mockReturnValue(stream([successResult("## File: a.ts\n```\nx\n```")]));
    const { output } = await new ClaudeCodeProvider().complete(req);
    expect(output.status).toBe("success");
    expect(output.output).toContain("## File: a.ts");
  });

  it("sends a single-turn, tools-disabled request with system + cached prefix", async () => {
    mockQuery.mockReturnValue(stream([successResult("x")]));
    await new ClaudeCodeProvider("opus").complete({ ...req, cachedPrefix: "REPO-CTX" });

    const arg = mockQuery.mock.calls[0][0];
    expect(arg.prompt).toContain("REPO-CTX");
    expect(arg.prompt).toContain("do it");
    expect(arg.options.systemPrompt).toBe("sys");
    expect(arg.options.model).toBe("opus");
    expect(arg.options.maxTurns).toBe(1);
    expect(arg.options.permissionMode).toBe("bypassPermissions");
    expect(arg.options.disallowedTools).toContain("Bash");
  });

  it("maps a usage/rate-limit error to RateLimitError", async () => {
    mockQuery.mockReturnValue(throwingStream(new Error("Usage limit reached — try again later")));
    await expect(new ClaudeCodeProvider().complete(req)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("rethrows non-limit errors unchanged", async () => {
    mockQuery.mockReturnValue(throwingStream(new Error("boom")));
    await expect(new ClaudeCodeProvider().complete(req)).rejects.toThrow(/boom/);
  });

  it("throws on an error-subtype result", async () => {
    mockQuery.mockReturnValue(stream([{ type: "result", subtype: "error_max_turns" }]));
    await expect(new ClaudeCodeProvider().complete(req)).rejects.toThrow(/error_max_turns/);
  });
});
