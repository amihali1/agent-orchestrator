import { describe, it, expect } from "vitest";
import { BacklogStore, BacklogState } from "./backlog-store";

function state(overrides: Partial<BacklogState> = {}): BacklogState {
  const now = new Date().toISOString();
  return {
    backlogId: "b1",
    projectName: "sticklers-gate",
    branch: "agent/backlog-abc123",
    status: "running",
    tasks: [
      { task: "t1", status: "done", commit: "aaa111" },
      { task: "t2", status: "pending" },
    ],
    currentIndex: 1,
    runTokens: 1200,
    localTokens: 3400,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("BacklogStore", () => {
  it("round-trips a backlog state through save/get", () => {
    const store = new BacklogStore(":memory:");
    const s = state();
    store.save(s);
    expect(store.get("b1")).toEqual(s);
  });

  it("upserts on conflict (save twice updates)", () => {
    const store = new BacklogStore(":memory:");
    store.save(state());
    store.save(state({ status: "done", currentIndex: 2, runTokens: 9999 }));
    const got = store.get("b1")!;
    expect(got.status).toBe("done");
    expect(got.currentIndex).toBe(2);
    expect(got.runTokens).toBe(9999);
  });

  it("listResumable returns paused/running, newest first, never done/failed", () => {
    const store = new BacklogStore(":memory:");
    store.save(state({ backlogId: "run1", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" }));
    store.save(state({ backlogId: "pause1", status: "paused", updatedAt: "2026-01-02T00:00:00.000Z" }));
    store.save(state({ backlogId: "done1", status: "done" }));
    store.save(state({ backlogId: "fail1", status: "failed" }));

    const ids = store.listResumable().map((s) => s.backlogId);
    expect(ids).toEqual(["pause1", "run1"]);
  });

  it("returns undefined for an unknown id", () => {
    expect(new BacklogStore(":memory:").get("nope")).toBeUndefined();
  });
});
