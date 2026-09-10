import { describe, it, expect } from "vitest";
import { BudgetTracker } from "./tracker";
import { TokenLedger } from "./ledger";
import { BudgetConfig } from "./config";
import { BudgetExceededError } from "./errors";
import { Usage } from "../types";

function usage(input: number, output: number): Usage {
  return { inputTokens: input, outputTokens: output };
}

function tracker(config: Partial<BudgetConfig> = {}, now = () => new Date("2026-08-28T12:00:00Z")) {
  const full: BudgetConfig = {
    maxTokensPerRun: config.maxTokensPerRun ?? 0,
    maxTokensPerDay: config.maxTokensPerDay ?? 0,
  };
  // In-memory sqlite so each test is isolated.
  return new BudgetTracker(full, new TokenLedger(":memory:"), now);
}

describe("BudgetTracker", () => {
  describe("record", () => {
    it("accumulates input + output tokens into run and day totals", () => {
      const t = tracker();
      t.record(usage(100, 50));
      t.record(usage(10, 5));
      const s = t.snapshot();
      expect(s.runTokens).toBe(165);
      expect(s.dayTokens).toBe(165);
    });

    it("ignores zero-token (local/Ollama) completions", () => {
      const t = tracker();
      t.record(usage(0, 0));
      expect(t.snapshot().runTokens).toBe(0);
    });

    it("tallies non-billable (local) tokens separately without touching the budget", () => {
      const t = tracker({ maxTokensPerRun: 100 });
      t.record({ inputTokens: 500, outputTokens: 300, billable: false });
      const s = t.snapshot();
      expect(s.localTokens).toBe(800);
      expect(s.runTokens).toBe(0);
      expect(s.dayTokens).toBe(0);
      // Well over the run cap, but non-billable, so no pause fires.
      expect(() => t.assertWithinBudget()).not.toThrow();
    });
  });

  describe("assertWithinBudget", () => {
    it("does not throw when under caps", () => {
      const t = tracker({ maxTokensPerRun: 1000 });
      t.record(usage(300, 200));
      expect(() => t.assertWithinBudget()).not.toThrow();
    });

    it("throws BudgetExceededError('run') when run cap is crossed", () => {
      const t = tracker({ maxTokensPerRun: 400 });
      t.record(usage(300, 200)); // 500 >= 400
      try {
        t.assertWithinBudget();
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(BudgetExceededError);
        expect((e as BudgetExceededError).scope).toBe("run");
        expect((e as BudgetExceededError).used).toBe(500);
      }
    });

    it("throws BudgetExceededError('day') when day cap is crossed", () => {
      const t = tracker({ maxTokensPerDay: 400 });
      t.record(usage(250, 250)); // 500 >= 400
      try {
        t.assertWithinBudget();
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(BudgetExceededError);
        expect((e as BudgetExceededError).scope).toBe("day");
      }
    });

    it("never throws when caps are 0 (unlimited)", () => {
      const t = tracker();
      t.record(usage(1_000_000, 1_000_000));
      expect(() => t.assertWithinBudget()).not.toThrow();
    });
  });

  describe("day ledger persistence", () => {
    it("shares a day total across trackers backed by the same db", () => {
      const ledger = new TokenLedger(":memory:");
      const cfg: BudgetConfig = { maxTokensPerRun: 0, maxTokensPerDay: 300 };
      const now = () => new Date("2026-08-28T12:00:00Z");

      const first = new BudgetTracker(cfg, ledger, now);
      first.record(usage(150, 0));
      expect(() => first.assertWithinBudget()).not.toThrow();

      // A fresh run (runTokens starts at 0) still sees the accumulated day total.
      const second = new BudgetTracker(cfg, ledger, now);
      second.record(usage(150, 0)); // day now 300 >= 300
      expect(() => second.assertWithinBudget()).toThrow(BudgetExceededError);
      expect(second.snapshot().runTokens).toBe(150);
      expect(second.snapshot().dayTokens).toBe(300);
    });
  });
});
