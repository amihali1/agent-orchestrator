import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../pipeline/runner", () => ({ runAgent: vi.fn() }));
vi.mock("./gather", () => ({
  gatherContext: vi.fn(async () => [{ path: "src/a.ts", content: "old" }]),
  renderContext: vi.fn(() => "CTX"),
}));
vi.mock("./apply", () => ({
  applyFiles: vi.fn(() => ["src/a.ts"]),
  commitAll: vi.fn(() => "abc1234"),
}));
vi.mock("./verifier", () => ({
  verify: vi.fn(),
  formatFailures: vi.fn(() => "gate feedback"),
}));

import { runAgent } from "../pipeline/runner";
import { verify } from "./verifier";
import { executeTask, tierForAttempt } from "./task";
import { BudgetTracker } from "../budget/tracker";
import { TokenLedger } from "../budget/ledger";
import { ProjectProfile } from "./profile";
import { AgentOutput } from "../types";

const mockRunAgent = vi.mocked(runAgent);
const mockVerify = vi.mocked(verify);

const profile = {
  name: "p",
  path: "/tmp/repo",
  stack: "x",
  commands: { typecheck: "x", lint: null, test: null, e2e: null },
  contextGlobs: [],
} as ProjectProfile;

function tracker() {
  return new BudgetTracker({ maxTokensPerRun: 0, maxTokensPerDay: 0 }, new TokenLedger(":memory:"));
}
function engineerOutput(): AgentOutput {
  return { status: "success", output: "## File: src/a.ts\n```\nnew\n```", reasoning: "r" };
}
const red = { ok: false, gates: [{ gate: "typecheck", command: "x", ok: false, output: "err" }] };
const green = { ok: true, gates: [] };

describe("tierForAttempt", () => {
  it("stays on the base tier before the threshold, escalates to smart at/after it", () => {
    expect(tierForAttempt("local", 0, 2)).toBe("local");
    expect(tierForAttempt("local", 1, 2)).toBe("local");
    expect(tierForAttempt("local", 2, 2)).toBe("smart");
    expect(tierForAttempt("local", 3, 2)).toBe("smart");
  });

  it("never escalates when escalateAfter is 0", () => {
    expect(tierForAttempt("local", 5, 0)).toBe("local");
  });

  it("is a no-op when the base tier is already smart", () => {
    expect(tierForAttempt("smart", 9, 2)).toBe("smart");
  });

  it("also escalates a cheap base tier", () => {
    expect(tierForAttempt("cheap", 2, 2)).toBe("smart");
  });
});

describe("executeTask cost-tiered retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.TIER_ENGINEER = "local"; // base tier = local
  });
  afterEach(() => {
    delete process.env.TIER_ENGINEER;
  });

  it("escalates the engineer local → smart after 2 failed attempts, then passes", async () => {
    mockRunAgent.mockResolvedValue(engineerOutput());
    mockVerify.mockReturnValueOnce(red).mockReturnValueOnce(red).mockReturnValueOnce(green);

    const r = await executeTask(profile, "do a thing", tracker(), {
      escalateAfter: 2,
      maxIterations: 3,
    });

    expect(r.ok).toBe(true);
    expect(r.iterations).toBe(3);
    expect(mockRunAgent).toHaveBeenCalledTimes(3);
    // 7th arg (index 6) is the tier override for each attempt.
    expect(mockRunAgent.mock.calls[0][6]).toBe("local");
    expect(mockRunAgent.mock.calls[1][6]).toBe("local");
    expect(mockRunAgent.mock.calls[2][6]).toBe("smart");
  });

  it("stays on local for every attempt when escalation is disabled", async () => {
    mockRunAgent.mockResolvedValue(engineerOutput());
    mockVerify.mockReturnValue(red);

    const r = await executeTask(profile, "do a thing", tracker(), {
      escalateAfter: 0,
      maxIterations: 3,
    });

    expect(r.ok).toBe(false);
    expect(mockRunAgent.mock.calls.every((c) => c[6] === "local")).toBe(true);
  });
});
