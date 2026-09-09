import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./pipeline", () => ({
  runPipeline: vi.fn(),
  resumePipeline: vi.fn(),
}));

import { runAutoResume, resumeDelayMs } from "./auto";
import { runPipeline, resumePipeline } from "./pipeline";
import { BudgetExceededError, RateLimitError } from "../budget/errors";
import { AgentResult } from "../types";

const mockRun = vi.mocked(runPipeline);
const mockResume = vi.mocked(resumePipeline);

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const now = () => NOW;

function withRunId<T extends Error>(err: T, id: string): T {
  (err as unknown as { runId?: string }).runId = id;
  return err;
}

function result(name: string): AgentResult {
  return { agentName: name, status: "success", output: "x", reasoning: "y", timestamp: new Date(), attempt: 1 };
}

describe("resumeDelayMs", () => {
  it("returns time until reset for a 429", () => {
    const err = new RateLimitError(60, NOW + 5000);
    expect(resumeDelayMs(err, now)).toBe(5000);
  });

  it("returns null for a per-run budget cap (never resets)", () => {
    expect(resumeDelayMs(new BudgetExceededError("run", 2000, 1500), now)).toBeNull();
  });

  it("returns time until next UTC midnight for a day cap", () => {
    // 12:00Z → 12h to midnight
    expect(resumeDelayMs(new BudgetExceededError("day", 5000, 4000), now)).toBe(12 * 3600 * 1000);
  });

  it("returns null for non-pause errors", () => {
    expect(resumeDelayMs(new Error("boom"), now)).toBeNull();
  });
});

describe("runAutoResume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("sleeps until the rate-limit reset, then resumes the same run", async () => {
    const err = withRunId(new RateLimitError(60, NOW + 5000), "r1");
    mockRun.mockRejectedValueOnce(err);
    mockResume.mockResolvedValueOnce([result("tester")]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const res = await runAutoResume("task", { agents: [] }, { now, sleep });

    expect(sleep).toHaveBeenCalledWith(5000);
    expect(mockResume).toHaveBeenCalledWith("r1", expect.anything());
    expect(res.map((r) => r.agentName)).toEqual(["tester"]);
  });

  it("does not sleep on a per-run cap — rethrows for manual resume", async () => {
    const err = withRunId(new BudgetExceededError("run", 2000, 1500), "r2");
    mockRun.mockRejectedValueOnce(err);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(runAutoResume("task", { agents: [] }, { now, sleep })).rejects.toBe(err);
    expect(sleep).not.toHaveBeenCalled();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("rethrows when the required wait exceeds maxSleepSec", async () => {
    const err = withRunId(new RateLimitError(60, NOW + 5000), "r3");
    mockRun.mockRejectedValueOnce(err);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      runAutoResume("task", { agents: [] }, { now, sleep, maxSleepSec: 1 })
    ).rejects.toBe(err);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns results directly when the run never pauses", async () => {
    mockRun.mockResolvedValueOnce([result("designer")]);
    const res = await runAutoResume("task", { agents: [] }, { now, sleep: vi.fn() });
    expect(res.map((r) => r.agentName)).toEqual(["designer"]);
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("sleeps repeatedly across multiple pauses until completion", async () => {
    mockRun.mockRejectedValueOnce(withRunId(new RateLimitError(60, NOW + 1000), "r4"));
    mockResume
      .mockRejectedValueOnce(withRunId(new RateLimitError(60, NOW + 2000), "r4"))
      .mockResolvedValueOnce([result("reviewer")]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const res = await runAutoResume("task", { agents: [] }, { now, sleep });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(mockResume).toHaveBeenCalledTimes(2);
    expect(res.map((r) => r.agentName)).toEqual(["reviewer"]);
  });
});
