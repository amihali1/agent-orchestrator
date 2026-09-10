import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadProfile, gatesDir } from "./profile";

const dirs: string[] = [];

function tmpProfileDir(profile: object, name = "proj"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-prof-"));
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(profile));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadProfile", () => {
  it("expands ${GATES} in gate commands to the absolute gates dir", () => {
    const dir = tmpProfileDir({
      name: "proj",
      path: os.tmpdir(), // must exist
      stack: "x",
      commands: {
        typecheck: 'powershell -File "${GATES}/unity-compile.ps1" "C:/proj"',
        lint: null,
        test: null,
        e2e: null,
      },
      contextGlobs: [],
    });

    const profile = loadProfile("proj", dir);
    expect(profile.commands.typecheck).toBe(
      `powershell -File "${gatesDir(dir)}/unity-compile.ps1" "C:/proj"`
    );
    expect(profile.commands.typecheck).not.toContain("${GATES}");
    expect(profile.commands.lint).toBeNull();
  });

  it("throws when the profile path is missing", () => {
    const dir = tmpProfileDir({
      name: "proj",
      path: path.join(os.tmpdir(), "definitely-does-not-exist-12345"),
      stack: "x",
      commands: { typecheck: null, lint: null, test: null, e2e: null },
      contextGlobs: [],
    });
    expect(() => loadProfile("proj", dir)).toThrow(/missing path/);
  });
});
