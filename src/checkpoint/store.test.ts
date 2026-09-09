import { describe, it, expect } from "vitest";
import { CheckpointStore, RunState } from "./store";
import { AgentResult } from "../types";

function makeResult(name: string): AgentResult {
  return {
    agentName: name,
    status: "success",
    output: `${name} output`,
    reasoning: "done",
    timestamp: new Date("2026-08-28T12:00:00Z"),
    attempt: 1,
  };
}

function makeState(overrides: Partial<RunState> = {}): RunState {
  const now = "2026-08-28T12:00:00.000Z";
  return {
    runId: "run-1",
    task: "build a thing",
    status: "running",
    currentIndex: 1,
    retryCounts: { engineer: 1 },
    history: [makeResult("designer")],
    runTokens: 500,
    agentNames: ["designer", "engineer", "tester"],
    noMemory: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function store() {
  return new CheckpointStore(":memory:");
}

describe("CheckpointStore", () => {
  it("round-trips a run state, reviving timestamps to Date", () => {
    const s = store();
    const state = makeState();
    s.save(state);

    const loaded = s.get("run-1");
    expect(loaded).toBeDefined();
    expect(loaded!.task).toBe("build a thing");
    expect(loaded!.currentIndex).toBe(1);
    expect(loaded!.retryCounts).toEqual({ engineer: 1 });
    expect(loaded!.runTokens).toBe(500);
    expect(loaded!.agentNames).toEqual(["designer", "engineer", "tester"]);
    expect(loaded!.noMemory).toBe(false);
    expect(loaded!.history[0].timestamp).toBeInstanceOf(Date);
    expect(loaded!.history[0].agentName).toBe("designer");
  });

  it("upserts on the same run_id (latest state wins)", () => {
    const s = store();
    s.save(makeState());
    s.save(makeState({ status: "paused", currentIndex: 2, runTokens: 900, pausedReason: "cap" }));

    const loaded = s.get("run-1")!;
    expect(loaded.status).toBe("paused");
    expect(loaded.currentIndex).toBe(2);
    expect(loaded.runTokens).toBe(900);
    expect(loaded.pausedReason).toBe("cap");
  });

  it("returns undefined for unknown run id", () => {
    expect(store().get("nope")).toBeUndefined();
  });

  it("lists only resumable runs (paused/running), newest first", () => {
    const s = store();
    s.save(makeState({ runId: "a", status: "done", updatedAt: "2026-08-28T10:00:00.000Z" }));
    s.save(makeState({ runId: "b", status: "paused", updatedAt: "2026-08-28T11:00:00.000Z" }));
    s.save(makeState({ runId: "c", status: "running", updatedAt: "2026-08-28T12:00:00.000Z" }));

    const ids = s.listResumable().map((r) => r.runId);
    expect(ids).toEqual(["c", "b"]);
  });
});
