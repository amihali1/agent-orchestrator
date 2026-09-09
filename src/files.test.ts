import { describe, it, expect } from "vitest";
import { extractFiles, extractFencedBlock } from "./files";

describe("extractFiles", () => {
  it("extracts a single file block with a language tag", () => {
    const md = "## File: src/a.ts\n```typescript\nexport const a = 1;\n```";
    const files = extractFiles(md);
    expect([...files.keys()]).toEqual(["src/a.ts"]);
    expect(files.get("src/a.ts")).toBe("export const a = 1;\n");
  });

  it("extracts multiple files", () => {
    const md =
      "## File: a.ts\n```ts\nconst a=1;\n```\n\nsome prose\n\n## File: b/c.tsx\n```tsx\nconst c=2;\n```";
    const files = extractFiles(md);
    expect([...files.keys()]).toEqual(["a.ts", "b/c.tsx"]);
    expect(files.get("b/c.tsx")).toBe("const c=2;\n");
  });

  it("returns empty map when no file blocks present", () => {
    expect(extractFiles("just prose, no files").size).toBe(0);
  });

  it("trims trailing whitespace and ensures a trailing newline", () => {
    const md = "## File: x.ts\n```\ncontent   \n\n\n```";
    expect(extractFiles(md).get("x.ts")).toBe("content\n");
  });
});

describe("extractFencedBlock", () => {
  it("returns the first fenced block ignoring the language tag", () => {
    expect(extractFencedBlock("prose\n```tsx\nconst a=1;\n```\nmore")).toBe("const a=1;\n");
  });

  it("returns undefined when there is no fenced block", () => {
    expect(extractFencedBlock("no code here")).toBeUndefined();
  });
});
