import { describe, it, expect } from "vitest";
import { parseAgentOutput } from "./types";

describe("parseAgentOutput", () => {
  it("passes through string fields", () => {
    const out = parseAgentOutput(
      { status: "success", output: "hello", reasoning: "because" },
      "fallback"
    );
    expect(out).toEqual({ status: "success", output: "hello", reasoning: "because", feedback: undefined });
  });

  it("coerces a non-string output (e.g. a JSON array) to a string", () => {
    // A model that returns `output` as an actual array rather than a string —
    // regression guard: this must not blow up downstream persistence.
    const out = parseAgentOutput({ status: "success", output: ["t1", "t2"], reasoning: 3 }, "");
    expect(out.output).toBe('["t1","t2"]');
    expect(out.reasoning).toBe("3");
  });

  it("falls back to free text when there is no structured output", () => {
    const out = parseAgentOutput(undefined, "raw text");
    expect(out).toEqual({ status: "success", output: "raw text", reasoning: "" });
  });
});
