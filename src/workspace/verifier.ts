import { spawnSync } from "child_process";
import { ProjectProfile } from "./profile";

export interface GateResult {
  gate: string;
  command: string;
  ok: boolean;
  /** Compacted stdout+stderr (only meaningful/kept when the gate fails). */
  output: string;
}

export interface VerifyResult {
  ok: boolean;
  gates: GateResult[];
}

const GATE_ORDER: (keyof ProjectProfile["commands"])[] = ["typecheck", "lint", "test", "e2e"];
const MAX_OUTPUT_LINES = 100;

/** Keep the tail of command output so failures stay token-cheap when fed back. */
function compact(output: string): string {
  const lines = output.split(/\r?\n/);
  if (lines.length <= MAX_OUTPUT_LINES) return output.trim();
  return `…(${lines.length - MAX_OUTPUT_LINES} earlier lines omitted)\n` +
    lines.slice(-MAX_OUTPUT_LINES).join("\n").trim();
}

function runCommand(command: string, cwd: string): { ok: boolean; output: string } {
  // shell:true so profile commands like "npx tsc --noEmit" run as written.
  const res = spawnSync(command, { cwd, shell: true, encoding: "utf-8" });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const ok = res.status === 0;
  return { ok, output };
}

/**
 * Run the project's real gates in order, skipping any whose command is null.
 * Stops at the first failure (no point testing if it doesn't typecheck).
 */
export function verify(profile: ProjectProfile): VerifyResult {
  const gates: GateResult[] = [];
  for (const gate of GATE_ORDER) {
    const command = profile.commands[gate];
    if (!command) continue;

    console.log(`  verifier: ${gate} → ${command}`);
    const { ok, output } = runCommand(command, profile.path);
    gates.push({ gate, command, ok, output: ok ? "" : compact(output) });
    if (!ok) return { ok: false, gates };
  }
  return { ok: true, gates };
}

/** Human/LLM-readable summary of failing gates, for the engineer revision feedback. */
export function formatFailures(result: VerifyResult): string {
  const failed = result.gates.filter((g) => !g.ok);
  if (failed.length === 0) return "";
  return failed
    .map((g) => `### Gate failed: ${g.gate} (\`${g.command}\`)\n\`\`\`\n${g.output}\n\`\`\``)
    .join("\n\n");
}
