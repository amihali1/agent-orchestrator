import "dotenv/config";
import { bootstrap } from "./workspace/bootstrap";
import { plan } from "./workspace/planner";
import { runBacklog, resumeBacklog, BacklogResult } from "./workspace/backlog";
import { withAutoResume } from "./pipeline/auto";
import { isPauseSignal, RateLimitError } from "./budget/errors";

function usage(): never {
  console.error(
    `Usage: npm run bootstrap -- <name> [--goal "<goal>"] [--base <dir>] [--no-install] [--dry-run]\n` +
      `\nCreates a minimal TS/Node repo + profile + initial commit. With --goal, also plans and runs the backlog.`
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let goal: string | undefined;
  let base: string | undefined;
  let install = true;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--goal") goal = argv[++i];
    else if (a === "--base") base = argv[++i];
    else if (a === "--no-install") install = false;
    else if (a === "--dry-run") dryRun = true;
    else positional.push(a);
  }
  return { positional, goal, base, install, dryRun };
}

function reportBacklog(r: BacklogResult) {
  console.log("\n" + "=".repeat(60));
  r.tasks.forEach((t, i) => {
    const mark = t.status === "done" ? "✓" : t.status === "failed" ? "✗" : "·";
    console.log(`  ${mark} ${i + 1}. ${t.task}${t.commit ? ` (${t.commit})` : ""}`);
  });
  console.log(
    r.ok
      ? `\n✓ Backlog complete on ${r.branch} — ${r.committed} commit(s)`
      : `\n✗ Backlog halted on ${r.branch}. Failed task: ${r.failedTask}`
  );
  console.log(`  tokens: ${r.tokens.run} billable (Claude) · ${r.tokens.local} local (Ollama, free)`);
}

async function main() {
  const { positional, goal, base, install, dryRun } = parseArgs(process.argv.slice(2));
  const name = positional[0];
  if (!name) usage();

  const result = await bootstrap(name, { base, install });
  console.log(`\n✓ Bootstrapped ${result.stack} project "${name}" at ${result.path}`);

  if (!goal) {
    console.log(`\nNext: npm run backlog -- ${name} --goal "<what to build>"`);
    return;
  }

  console.log(`\nPlanning goal: ${goal}`);
  const { tasks, tokens } = await plan(name, goal);
  console.log(`Planner produced ${tasks.length} task(s):`);
  tasks.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log(`  planning tokens: ${tokens.run} billable (Claude) · ${tokens.local} local (Ollama, free)`);

  const backlog = await withAutoResume(
    () => runBacklog(name, tasks, { dryRun }),
    (id) => resumeBacklog(id, { dryRun })
  );
  reportBacklog(backlog);
}

main().catch((err) => {
  if (isPauseSignal(err)) {
    const backlogId = (err as { runId?: string }).runId;
    console.log(`\n⏸  Paused: ${err.message}`);
    if (err instanceof RateLimitError) console.log(`   Resume after ${new Date(err.resumeAtMs).toISOString()}.`);
    if (backlogId) console.log(`   Resume with:  npm run backlog -- --resume ${backlogId}`);
    process.exit(0);
  }
  console.error("Bootstrap failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
