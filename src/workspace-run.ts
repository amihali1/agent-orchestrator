import "dotenv/config";
import { runWorkspace, resumeWorkspace, WorkspaceResult } from "./workspace/orchestrator";
import { withAutoResume } from "./pipeline/auto";
import { isPauseSignal, RateLimitError } from "./budget/errors";

function usage(): never {
  console.error(
    `Usage: npm run workspace -- <project> "<task>" [--files a.ts,b.tsx] [--dry-run]\n` +
      `       npm run workspace -- --resume <run_id> [--dry-run]`
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let files: string[] | undefined;
  let dryRun = false;
  let resume: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--files") files = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--resume") resume = argv[++i];
    else positional.push(a);
  }
  return { positional, files, dryRun, resume };
}

function report(r: WorkspaceResult) {
  console.log("\n" + "=".repeat(60));
  if (r.ok) {
    console.log(`✓ Success in ${r.iterations} iteration(s) on ${r.branch}`);
    console.log(r.committed ? `  committed ${r.commit}` : `  dry-run — no commit`);
    console.log(`  files: ${r.written.join(", ")}`);
  } else {
    console.log(`✗ Failed after ${r.iterations} iteration(s). Branch ${r.branch} left for inspection.`);
    if (r.failureSummary) console.log(`\n${r.failureSummary}`);
  }
}

async function main() {
  const { positional, files, dryRun, resume } = parseArgs(process.argv.slice(2));

  const result = resume
    ? await withAutoResume(
        () => resumeWorkspace(resume, { dryRun }),
        (runId) => resumeWorkspace(runId, { dryRun })
      )
    : await (async () => {
        const [project, task] = positional;
        if (!project || !task) usage();
        return withAutoResume(
          () => runWorkspace(project, task, { files, dryRun }),
          (runId) => resumeWorkspace(runId, { dryRun })
        );
      })();

  report(result);
}

main().catch((err) => {
  if (isPauseSignal(err)) {
    const runId = (err as { runId?: string }).runId;
    console.log(`\n⏸  Paused: ${err.message}`);
    if (err instanceof RateLimitError) {
      console.log(`   Resume after ${new Date(err.resumeAtMs).toISOString()}.`);
    }
    if (runId) console.log(`   Resume with:  npm run workspace -- --resume ${runId}`);
    process.exit(0);
  }
  console.error("Workspace run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
