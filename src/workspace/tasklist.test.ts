import { describe, it, expect } from "vitest";
import { parseTaskList } from "./tasklist";

describe("parseTaskList", () => {
  it("parses a JSON array of strings", () => {
    expect(parseTaskList('["a task", "b task", "c"]')).toEqual(["a task", "b task", "c"]);
  });

  it("trims and drops empty entries in a JSON array", () => {
    expect(parseTaskList('["  a  ", "", "b"]')).toEqual(["a", "b"]);
  });

  it("extracts a JSON array even when wrapped in prose", () => {
    expect(parseTaskList('Here is the plan:\n["x", "y"]\nGood luck!')).toEqual(["x", "y"]);
  });

  it("parses a markdown checklist (- and *), tolerating checkboxes", () => {
    const md = `# Plan\n- first task\n* second task\n- [ ] third task\n- [x] done task\nnot a task`;
    expect(parseTaskList(md)).toEqual(["first task", "second task", "third task", "done task"]);
  });

  it("parses a bracketed list with unquoted, comma-separated items (sloppy local model)", () => {
    expect(parseTaskList("[add a Mana field, spend mana on cast, regen at end of turn]")).toEqual([
      "add a Mana field",
      "spend mana on cast",
      "regen at end of turn",
    ]);
  });

  it("returns [] for prose with no list", () => {
    expect(parseTaskList("just some prose, nothing actionable")).toEqual([]);
  });

  it("returns [] for a non-array JSON object", () => {
    expect(parseTaskList('{"tasks": 3}')).toEqual([]);
  });
});
