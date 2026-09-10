/**
 * Parse an ordered task list from either a JSON array of strings or a markdown
 * `- ` / `* ` checklist (checkbox prefixes tolerated). Shared by the backlog file
 * loader and the planner output parser. A JSON array anywhere in the text wins;
 * otherwise every markdown list item becomes a task. Returns [] when nothing parses
 * (callers validate non-empty).
 */
export function parseTaskList(text: string): string[] {
  // Some models return the array as a JSON value rather than a string — coerce.
  if (Array.isArray(text)) return (text as unknown[]).map((t) => String(t).trim()).filter(Boolean);
  const trimmed = String(text).trim();

  // 1. A valid JSON array anywhere in the text (tolerates prose wrapping).
  const open = trimmed.indexOf("[");
  const close = trimmed.lastIndexOf("]");
  if (open !== -1 && close > open) {
    try {
      const arr = JSON.parse(trimmed.slice(open, close + 1));
      if (Array.isArray(arr)) return arr.map((t) => String(t).trim()).filter(Boolean);
    } catch {
      // fall through
    }
  }

  // 2. The whole message is a bracketed list but not valid JSON — small local models
  //    often emit unquoted items. Split the body on newlines (or commas). Gated to a
  //    leading "[" so markdown "[ ]" checkboxes don't trigger this.
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const body = trimmed.slice(1, -1).trim();
    const clean = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();
    const parts = (body.includes("\n") ? body.split("\n") : body.split(","))
      .map(clean)
      .filter(Boolean);
    if (parts.length > 0) return parts;
  }

  const tasks: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/);
    if (m) tasks.push(m[1].trim());
  }
  return tasks;
}
