import "dotenv/config";
import fs from "fs";
import { runBacklog, resumeBacklog, BacklogResult } from "./workspace/backlog";
import { plan } from "./workspace/planner";
import { parseTaskList } from "./workspace/tasklist";
import { withAutoResume } from "./pipeline/auto";
import { isPauseSignal, RateLimitError } from "./budget/errors";

function usage(): never {
  console.error(
    `Usage: npm run backlog -- <project> <backlog-file> [--dry-run]\n` +
      `       npm run backlog -- <project> --goal "<goal>" [--dry-run]\n` +
      `       npm run backlog -- --resume <backlog_id> [--dry-run]\n` +
      `\n<backlog-file>: a .json array of task strings, or a markdown "- " checklist.\n` +
      `--goal: let the planner generate the task list from a high-level goal, then run it.`
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let dryRun = false;
  let resume: string | undefined;
  let goal: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--resume") resume = argv[++i];
    else if (a === "--goal") goal = argv[++i];
    else positional.push(a);
  }
  return { positional, dryRun, resume, goal };
}

/** Read an ordered task list from a JSON array file or a markdown checklist. */
function loadTasks(file: string): string[] {
  return parseTaskList(fs.readFileSync(file, "utf-8"));
}

function report(r: BacklogResult) {
  console.log("\n" + "=".repeat(60));
  r.tasks.forEach((t, i) => {
    const mark = t.status === "done" ? "✓" : t.status === "failed" ? "✗" : "·";
    console.log(`  ${mark} ${i + 1}. ${t.task}${t.commit ? ` (${t.commit})` : ""}`);
  });
  if (r.ok) {
    console.log(`\n✓ Backlog complete on ${r.branch} — ${r.committed} commit(s)`);
  } else {
    console.log(`\n✗ Backlog halted on ${r.branch}. Failed task: ${r.failedTask}`);
  }
  console.log(`  tokens: ${r.tokens.run} billable (Claude) · ${r.tokens.local} local (Ollama, free)`);
}

async function resolveTasks(project: string, goal: string): Promise<string[]> {
  console.log(`Planning goal for ${project}: ${goal}`);
  const { tasks, tokens } = await plan(project, goal);
  console.log(`Planner produced ${tasks.length} task(s):`);
  tasks.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log(`  planning tokens: ${tokens.run} billable (Claude) · ${tokens.local} local (Ollama, free)`);
  return tasks;
}

async function main() {
  const { positional, dryRun, resume, goal } = parseArgs(process.argv.slice(2));

  let result: BacklogResult;
  if (resume) {
    result = await withAutoResume(
      () => resumeBacklog(resume, { dryRun }),
      (id) => resumeBacklog(id, { dryRun })
    );
  } else {
    const [project, file] = positional;
    if (!project) usage();

    let tasks: string[];
    if (goal) {
      tasks = await resolveTasks(project, goal);
    } else {
      if (!file) usage();
      tasks = loadTasks(file);
      if (tasks.length === 0) {
        console.error(`No tasks parsed from ${file}`);
        process.exit(1);
      }
      console.log(`Loaded ${tasks.length} task(s) from ${file}`);
    }

    result = await withAutoResume(
      () => runBacklog(project, tasks, { dryRun }),
      (id) => resumeBacklog(id, { dryRun })
    );
  }

  report(result);
}

main().catch((err) => {
  if (isPauseSignal(err)) {
    const backlogId = (err as { runId?: string }).runId;
    console.log(`\n⏸  Paused: ${err.message}`);
    if (err instanceof RateLimitError) {
      console.log(`   Resume after ${new Date(err.resumeAtMs).toISOString()}.`);
    }
    if (backlogId) console.log(`   Resume with:  npm run backlog -- --resume ${backlogId}`);
    process.exit(0);
  }
  console.error("Backlog run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
