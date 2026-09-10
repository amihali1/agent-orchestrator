import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the single-task executor so we test the DRIVER loop in isolation (no git,
// no engineer/network, no verifier). The real executeTask path is covered by live
// verification and the apply/verifier unit tests.
vi.mock("./task", () => ({ executeTask: vi.fn() }));

import { executeTask } from "./task";
import { executeBacklog } from "./backlog";
import { BacklogStore, BacklogState } from "../checkpoint/backlog-store";
import { BudgetTracker } from "../budget/tracker";
import { TokenLedger } from "../budget/ledger";
import { BudgetConfig } from "../budget/config";
import { ProjectProfile } from "./profile";

const mockExec = vi.mocked(executeTask);

const profile = {
  name: "p",
  path: "/tmp/repo",
  stack: "x",
  commands: { typecheck: null, lint: null, test: null, e2e: null },
  contextGlobs: [],
} as ProjectProfile;

function state(tasks: string[], overrides: Partial<BacklogState> = {}): BacklogState {
  const now = new Date().toISOString();
  return {
    backlogId: "b1",
    projectName: "p",
    branch: "agent/backlog-x",
    status: "running",
    tasks: tasks.map((t) => ({ task: t, status: "pending" as const })),
    currentIndex: 0,
    runTokens: 0,
    localTokens: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function tracker(config: Partial<BudgetConfig> = {}) {
  const full: BudgetConfig = {
    maxTokensPerRun: config.maxTokensPerRun ?? 0,
    maxTokensPerDay: config.maxTokensPerDay ?? 0,
  };
  return new BudgetTracker(full, new TokenLedger(":memory:"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("executeBacklog", () => {
  it("runs every task, commits each, and records tokens", async () => {
    const t = tracker();
    mockExec.mockImplementation(async () => {
      t.record({ inputTokens: 10, outputTokens: 5, billable: false }); // local tokens
      return { ok: true, written: ["f"], commit: "c" + mockExec.mock.calls.length, iterations: 1 };
    });
    const store = new BacklogStore(":memory:");

    const r = await executeBacklog(profile, state(["t1", "t2", "t3"]), { store, tracker: t });

    expect(r.ok).toBe(true);
    expect(r.committed).toBe(3);
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(r.tasks.map((x) => x.status)).toEqual(["done", "done", "done"]);
    expect(r.tasks.map((x) => x.commit)).toEqual(["c1", "c2", "c3"]);
    expect(r.tokens.local).toBe(45);
    expect(r.tokens.run).toBe(0);

    const saved = store.get("b1")!;
    expect(saved.status).toBe("done");
    expect(saved.localTokens).toBe(45);
  });

  it("halts on the first failing task and never runs later ones", async () => {
    mockExec
      .mockResolvedValueOnce({ ok: true, written: [], commit: "c1", iterations: 1 })
      .mockResolvedValueOnce({ ok: false, written: [], failureSummary: "gate red", iterations: 3 });
    const store = new BacklogStore(":memory:");

    const r = await executeBacklog(profile, state(["t1", "t2", "t3"]), { store, tracker: tracker() });

    expect(r.ok).toBe(false);
    expect(r.failedTask).toBe("t2");
    expect(r.committed).toBe(1);
    expect(mockExec).toHaveBeenCalledTimes(2); // t3 never runs
    expect(r.tasks.map((x) => x.status)).toEqual(["done", "failed", "pending"]);
    expect(store.get("b1")!.status).toBe("failed");
  });

  it("resumes from currentIndex, skipping already-done tasks", async () => {
    mockExec.mockResolvedValue({ ok: true, written: [], commit: "c3", iterations: 1 });
    const s = state(["t1", "t2", "t3"], {
      currentIndex: 2,
      tasks: [
        { task: "t1", status: "done", commit: "c1" },
        { task: "t2", status: "done", commit: "c2" },
        { task: "t3", status: "pending" },
      ],
    });

    const r = await executeBacklog(profile, s, { store: new BacklogStore(":memory:"), tracker: tracker() });

    expect(mockExec).toHaveBeenCalledTimes(1); // only t3
    expect(r.ok).toBe(true);
    expect(r.committed).toBe(3);
  });

  it("checkpoints and rethrows a budget pause tagged with the backlog id", async () => {
    const t = tracker({ maxTokensPerRun: 50 });
    mockExec.mockImplementation(async () => {
      t.record({ inputTokens: 80, outputTokens: 0, billable: true }); // trips the 50 cap
      return { ok: true, written: [], commit: "c", iterations: 1 };
    });
    const store = new BacklogStore(":memory:");

    await expect(
      executeBacklog(profile, state(["t1", "t2", "t3"]), { store, tracker: t })
    ).rejects.toMatchObject({ runId: "b1" });

    expect(mockExec).toHaveBeenCalledTimes(1); // paused after task 1
    const saved = store.get("b1")!;
    expect(saved.status).toBe("paused");
    expect(saved.currentIndex).toBe(1); // task 0 done; resume point is task 1
    expect(saved.tasks[0].status).toBe("done");
  });
});
