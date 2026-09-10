import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { bootstrap } from "./bootstrap";
import { assertCleanRepo } from "./apply";
import { loadProfile } from "./profile";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("bootstrap", () => {
  it("scaffolds a committed git repo + registered profile (no install)", async () => {
    const base = tmp("ap-boot-base-");
    const profileDir = tmp("ap-boot-prof-");

    const r = await bootstrap("demoapp", { base, profileDir, install: false, verifyBaseline: false });

    expect(r.path).toBe(path.resolve(base, "demoapp"));
    expect(r.stack).toBe("ts-node");
    expect(fs.existsSync(path.join(r.path, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(r.path, "src/index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(r.path, "src/index.test.ts"))).toBe(true);

    // Initial commit made → clean tree, ready for the workspace spine.
    expect(() => assertCleanRepo(r.path)).not.toThrow();

    // Profile registered and loadable with the ts-node gates.
    const p = loadProfile("demoapp", profileDir);
    expect(p.commands.typecheck).toBe("npx tsc --noEmit");
    expect(p.commands.test).toBe("npx vitest run");
    expect(p.path).toBe(r.path.replace(/\\/g, "/"));
  });

  it("rejects an existing target", async () => {
    const base = tmp("ap-boot-base-");
    fs.mkdirSync(path.join(base, "taken"));
    await expect(
      bootstrap("taken", { base, install: false, verifyBaseline: false })
    ).rejects.toThrow(/already exists/);
  });

  it("rejects an invalid project name before touching the filesystem", async () => {
    await expect(bootstrap("bad name!", { install: false })).rejects.toThrow(/Invalid project name/);
  });
});
