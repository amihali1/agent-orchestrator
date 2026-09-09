import { describe, it, expect } from "vitest";
import { verify, formatFailures } from "./verifier";
import { ProjectProfile } from "./profile";

function profile(commands: ProjectProfile["commands"]): ProjectProfile {
  return { name: "t", path: process.cwd(), stack: "x", commands, contextGlobs: [] };
}

const pass = 'node -e "process.exit(0)"';
const fail = 'node -e "console.error(\'boom\');process.exit(1)"';

describe("verify", () => {
  it("passes when the single gate exits 0", () => {
    const r = verify(profile({ typecheck: pass, lint: null, test: null, e2e: null }));
    expect(r.ok).toBe(true);
    expect(r.gates.map((g) => g.gate)).toEqual(["typecheck"]);
  });

  it("skips null commands and runs only configured gates", () => {
    const r = verify(profile({ typecheck: null, lint: null, test: pass, e2e: null }));
    expect(r.ok).toBe(true);
    expect(r.gates.map((g) => g.gate)).toEqual(["test"]);
  });

  it("fails and captures output on a non-zero gate", () => {
    const r = verify(profile({ typecheck: fail, lint: null, test: null, e2e: null }));
    expect(r.ok).toBe(false);
    expect(r.gates[0].gate).toBe("typecheck");
    expect(r.gates[0].output).toContain("boom");
  });

  it("stops at the first failing gate (does not run later gates)", () => {
    const r = verify(profile({ typecheck: fail, lint: null, test: pass, e2e: null }));
    expect(r.ok).toBe(false);
    expect(r.gates).toHaveLength(1); // test never ran
  });
});

describe("formatFailures", () => {
  it("summarizes only failing gates", () => {
    const r = verify(profile({ typecheck: fail, lint: null, test: null, e2e: null }));
    const summary = formatFailures(r);
    expect(summary).toContain("typecheck");
    expect(summary).toContain("boom");
  });

  it("returns empty string when nothing failed", () => {
    const r = verify(profile({ typecheck: pass, lint: null, test: null, e2e: null }));
    expect(formatFailures(r)).toBe("");
  });
});
