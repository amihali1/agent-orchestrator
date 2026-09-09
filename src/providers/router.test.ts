import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveTier } from "./router";

// Keep provider construction cheap and offline in tests.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

describe("resolveTier", () => {
  it("defaults to smart when nothing is configured", () => {
    expect(resolveTier("engineer", undefined, {})).toBe("smart");
  });

  it("uses the agent's configured tier when set", () => {
    expect(resolveTier("tester", "cheap", {})).toBe("cheap");
  });

  it("lets an env TIER_<AGENT> override win over the configured tier", () => {
    expect(resolveTier("tester", "smart", { TIER_TESTER: "local" })).toBe("local");
  });

  it("is case-insensitive on the env value", () => {
    expect(resolveTier("tester", undefined, { TIER_TESTER: "LOCAL" })).toBe("local");
  });

  it("ignores an invalid env value and falls back", () => {
    expect(resolveTier("tester", "cheap", { TIER_TESTER: "bogus" })).toBe("cheap");
  });
});

describe("getProvider smart-tier selection", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.resetModules(); // bust the memoized provider cache between cases
    process.env = { ...OLD_ENV, ANTHROPIC_API_KEY: "sk-test" };
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("routes smart through the Claude Agent SDK by default", async () => {
    delete process.env.SMART_PROVIDER;
    const { getProvider } = await import("./router");
    expect(getProvider("smart").constructor.name).toBe("ClaudeCodeProvider");
  });

  it("routes smart through the API when SMART_PROVIDER=api", async () => {
    process.env.SMART_PROVIDER = "api";
    const { getProvider } = await import("./router");
    expect(getProvider("smart").constructor.name).toBe("AnthropicProvider");
  });
});
