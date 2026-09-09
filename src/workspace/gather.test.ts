import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { gatherContext, renderContext } from "./gather";
import { ProjectProfile } from "./profile";

const dirs: string[] = [];

function tmpProject(): ProjectProfile {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-gather-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "AAAA");
  fs.writeFileSync(path.join(dir, "src", "b.tsx"), "BBBB");
  fs.writeFileSync(path.join(dir, "node_modules", "pkg", "c.ts"), "CCCC");
  return {
    name: "t",
    path: dir,
    stack: "x",
    commands: { typecheck: null, lint: null, test: null, e2e: null },
    contextGlobs: ["src/**/*.ts", "src/**/*.tsx"],
  };
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("gatherContext", () => {
  it("reads files matching the profile globs, ignoring node_modules", async () => {
    const files = await gatherContext(tmpProject());
    expect(files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.tsx"]);
    expect(files.find((f) => f.path === "src/a.ts")!.content).toBe("AAAA");
  });

  it("honors an explicit files list over the profile globs", async () => {
    const files = await gatherContext(tmpProject(), ["src/a.ts"]);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  it("stops adding files once the byte cap is exceeded", async () => {
    const files = await gatherContext(tmpProject(), undefined, 4); // one 4-byte file fits, second exceeds
    expect(files.length).toBe(1);
  });
});

describe("renderContext", () => {
  it("returns empty string for no files", () => {
    expect(renderContext([])).toBe("");
  });

  it("renders File blocks", () => {
    const out = renderContext([{ path: "src/a.ts", content: "X" }]);
    expect(out).toContain("## File: src/a.ts");
    expect(out).toContain("X");
  });
});
