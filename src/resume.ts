import "dotenv/config";
import fs from "fs";
import path from "path";
import { resumePipeline } from "./pipeline/pipeline";
import { engineer, tester, reviewer, designer } from "./agents";
import { CheckpointStore } from "./checkpoint/store";
import { isPauseSignal, RateLimitError } from "./budget/errors";
import { AgentResult } from "./types";

// Full roster; resumePipeline re-binds only the agents the run actually used.
const agents = [designer, engineer, tester, reviewer];

function saveOutputs(results: AgentResult[]) {
  const finalOutputs = new Map<string, AgentResult>();
  for (const result of [...results].reverse()) {
    if (!finalOutputs.has(result.agentName) && result.status === "success") {
      finalOutputs.set(result.agentName, result);
    }
  }

  const outputDir = path.join(process.cwd(), "output");
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [name, result] of finalOutputs) {
    console.log(`\n## ${name.toUpperCase()}\n`);
    console.log(result.output);
    fs.writeFileSync(
      path.join(outputDir, `${name}.md`),
      `# ${name.toUpperCase()} Output\n\n${result.output}\n`
    );
  }
  console.log(`\nOutputs saved to ${outputDir}/`);
}

async function main() {
  const runId = process.argv[2];

  if (!runId || runId === "--list") {
    const resumable = new CheckpointStore().listResumable();
    if (resumable.length === 0) {
      console.log("No resumable runs.");
    } else {
      console.log("Resumable runs:\n");
      for (const r of resumable) {
        console.log(
          `  ${r.runId}  [${r.status}]  step ${r.currentIndex}/${r.agentNames.length}` +
            `  ${r.runTokens} tok  — "${r.task.slice(0, 50)}"`
        );
        if (r.pausedReason) console.log(`      reason: ${r.pausedReason}`);
      }
    }
    if (!runId) {
      console.log("\nUsage: npm run resume -- <run_id>");
      process.exit(1);
    }
    return;
  }

  const results = await resumePipeline(runId, { agents });
  console.log("\n" + "=".repeat(60));
  saveOutputs(results);
}

main().catch((err) => {
  if (isPauseSignal(err)) {
    const rid = (err as { runId?: string }).runId;
    console.log(`\n⏸  Paused again: ${err.message}`);
    if (err instanceof RateLimitError) {
      console.log(`   Resume after ${new Date(err.resumeAtMs).toISOString()}.`);
    }
    if (rid) console.log(`   Resume with:  npm run resume -- ${rid}`);
    process.exit(0);
  }
  console.error("Resume failed:", err);
  process.exit(1);
});
