import { describe, it, expect } from "vitest";
import { TEMPLATES } from "./templates";

describe("ts-node template", () => {
  const t = TEMPLATES["ts-node"];

  it("is registered", () => {
    expect(t).toBeDefined();
    expect(t.stack).toBe("ts-node");
  });

  it("emits a valid package.json and tsconfig, plus src + a test", () => {
    const files = t.files("my-app");
    const pkg = JSON.parse(files["package.json"]);
    expect(pkg.name).toBe("my-app");
    expect(pkg.scripts.test).toContain("vitest");
    expect(pkg.devDependencies.typescript).toBeDefined();

    expect(() => JSON.parse(files["tsconfig.json"])).not.toThrow();
    expect(files["src/index.ts"]).toContain("export function");
    expect(files["src/index.test.ts"]).toContain('from "vitest"');
    expect(files[".gitignore"]).toContain("node_modules/");
  });

  it("builds a profile with the ts-node gates and forward-slash path", () => {
    const p = t.profile("my-app", "C:\\Dev\\my-app");
    expect(p.name).toBe("my-app");
    expect(p.path).toBe("C:/Dev/my-app");
    expect(p.commands.typecheck).toBe("npx tsc --noEmit");
    expect(p.commands.test).toBe("npx vitest run");
    expect(p.contextGlobs).toEqual(["src/**/*.ts"]);
  });
});
