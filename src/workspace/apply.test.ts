import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  assertCleanRepo,
  applyFiles,
  createBranch,
  commitAll,
  currentBranch,
} from "./apply";

const repos: string[] = [];

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-apply-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.dev"]);
  g(["config", "user.name", "tester"]);
  g(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  repos.push(dir);
  return dir;
}

afterEach(() => {
  while (repos.length) fs.rmSync(repos.pop()!, { recursive: true, force: true });
});

describe("assertCleanRepo", () => {
  it("passes on a clean repo", () => {
    expect(() => assertCleanRepo(tmpRepo())).not.toThrow();
  });

  it("throws when the tree is dirty", () => {
    const dir = tmpRepo();
    fs.writeFileSync(path.join(dir, "dirty.txt"), "x");
    expect(() => assertCleanRepo(dir)).toThrow(/uncommitted/);
  });

  it("throws when not a git repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-nogit-"));
    repos.push(dir);
    expect(() => assertCleanRepo(dir)).toThrow(/not a git repository/);
  });
});

describe("applyFiles", () => {
  it("writes files under the repo root", () => {
    const dir = tmpRepo();
    const written = applyFiles(dir, new Map([["src/a.ts", "export const a=1;\n"]]));
    expect(fs.readFileSync(path.join(dir, "src/a.ts"), "utf-8")).toBe("export const a=1;\n");
    expect(written.length).toBe(1);
  });

  it("refuses to write outside the repo root", () => {
    const dir = tmpRepo();
    expect(() => applyFiles(dir, new Map([["../evil.txt", "x"]]))).toThrow(/outside repo root/);
    expect(fs.existsSync(path.join(dir, "..", "evil.txt"))).toBe(false);
  });

  it("writes nothing if any path is unsafe (all-or-nothing)", () => {
    const dir = tmpRepo();
    expect(() =>
      applyFiles(dir, new Map([["ok.ts", "x"], ["../bad.ts", "y"]]))
    ).toThrow(/outside repo root/);
    expect(fs.existsSync(path.join(dir, "ok.ts"))).toBe(false);
  });
});

describe("branch + commit", () => {
  it("creates an agent/ branch and commits applied files", () => {
    const dir = tmpRepo();
    const branch = createBranch(dir, "Add a Footer!");
    expect(branch).toMatch(/^agent\/add-a-footer-[0-9a-f]{6}$/);
    expect(currentBranch(dir)).toBe(branch);

    applyFiles(dir, new Map([["src/a.ts", "export const a=1;\n"]]));
    const sha = commitAll(dir, "agent: add a");
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(() => assertCleanRepo(dir)).not.toThrow(); // committed → clean
  });
});
