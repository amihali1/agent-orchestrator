import { ProjectProfile } from "./profile";

/** A greenfield project skeleton plus the profile that makes it gate-verifiable. */
export interface Template {
  stack: string;
  /** Relative-path → file-contents for the initial skeleton. */
  files(name: string): Record<string, string>;
  /** The profile registered for the new project (absolute repo path). */
  profile(name: string, absPath: string): ProjectProfile;
}

const tsNode: Template = {
  stack: "ts-node",
  files(name) {
    const pkg = {
      name,
      version: "0.1.0",
      private: true,
      scripts: { build: "tsc", test: "vitest run" },
      devDependencies: {
        typescript: "^5.4.0",
        vitest: "^3.0.0",
        "@types/node": "^20.11.0",
      },
    };
    const tsconfig = {
      compilerOptions: {
        target: "ES2020",
        module: "CommonJS",
        moduleResolution: "node",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: "dist",
        rootDir: "src",
      },
      include: ["src"],
    };
    return {
      "package.json": JSON.stringify(pkg, null, 2) + "\n",
      "tsconfig.json": JSON.stringify(tsconfig, null, 2) + "\n",
      "src/index.ts": `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
      "src/index.test.ts":
        `import { describe, it, expect } from "vitest";\n` +
        `import { add } from "./index";\n\n` +
        `describe("add", () => {\n` +
        `  it("adds two numbers", () => {\n` +
        `    expect(add(2, 3)).toBe(5);\n` +
        `  });\n` +
        `});\n`,
      "README.md": `# ${name}\n\nBootstrapped by agent-orchestrator (ts-node template).\n`,
      ".gitignore": `node_modules/\ndist/\n`,
    };
  },
  profile(name, absPath) {
    return {
      name,
      path: absPath.replace(/\\/g, "/"),
      stack: "ts-node",
      commands: {
        typecheck: "npx tsc --noEmit",
        lint: null,
        test: "npx vitest run",
        e2e: null,
      },
      contextGlobs: ["src/**/*.ts"],
    };
  },
};

export const TEMPLATES: Record<string, Template> = {
  "ts-node": tsNode,
};
