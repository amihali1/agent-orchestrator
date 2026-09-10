import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf-8" });
}

/** Throw unless `repoPath` is a git repo with a clean working tree. */
export function assertCleanRepo(repoPath: string): void {
  try {
    git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(`${repoPath} is not a git repository`);
  }
  const status = git(repoPath, ["status", "--porcelain"]).trim();
  if (status) {
    throw new Error(
      `${repoPath} has uncommitted changes — commit/stash first (workspace mode needs a clean tree)`
    );
  }
}

export function slugify(task: string): string {
  return (
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

/** Create and check out a fresh `agent/<slug>-<shortid>` branch. Returns its name. */
export function createBranch(repoPath: string, task: string): string {
  const branch = `agent/${slugify(task)}-${crypto.randomBytes(3).toString("hex")}`;
  git(repoPath, ["checkout", "-b", branch]);
  return branch;
}

/**
 * Write engineer-produced files into the repo. Rejects any path that escapes the
 * repo root (absolute paths, `..`, symlink-style traversal) before writing anything.
 */
export function applyFiles(repoPath: string, files: Map<string, string>): string[] {
  const root = path.resolve(repoPath);
  const written: string[] = [];

  // Validate all paths first — write nothing if any is unsafe.
  const resolved = new Map<string, string>();
  for (const [rel, content] of files) {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`Refusing to write outside repo root: "${rel}"`);
    }
    resolved.set(abs, content);
  }

  for (const [abs, content] of resolved) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written.push(path.relative(root, abs));
  }
  return written;
}

/** Stage everything and commit. Returns the new commit's short SHA. */
export function commitAll(repoPath: string, message: string): string {
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-m", message]);
  return git(repoPath, ["rev-parse", "--short", "HEAD"]).trim();
}

export function currentBranch(repoPath: string): string {
  return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

/** Check out an existing branch (used on resume). */
export function checkoutBranch(repoPath: string, branch: string): void {
  git(repoPath, ["checkout", branch]);
}

/**
 * Initialize a fresh git repo at `repoPath` with `main` as the initial branch and a
 * repo-local commit identity, so `commitAll` works even where no global git identity
 * is configured (CI, clean machines).
 */
export function initRepo(repoPath: string): void {
  git(repoPath, ["init", "-b", "main"]);
  git(repoPath, ["config", "user.email", "agent@orchestrator.local"]);
  git(repoPath, ["config", "user.name", "agent-orchestrator"]);
  git(repoPath, ["config", "commit.gpgsign", "false"]);
}

/**
 * Discard all working-tree and index changes, returning to the current branch tip.
 * Used on backlog resume to drop partial edits from a task that was interrupted
 * mid-flight, so it can be re-run cleanly from the last committed task.
 */
export function resetHard(repoPath: string): void {
  git(repoPath, ["reset", "--hard", "HEAD"]);
}
