import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import { runAutoResume } from "./pipeline/auto";
import { engineer, tester, reviewer, designer } from "./agents";
import { MemoryStore } from "./memory/store";
import { AgentResult } from "./types";
import { isPauseSignal, RateLimitError } from "./budget/errors";

const agents = [designer, engineer, tester, reviewer];

function parseArgs(): { task: string; noMemory: boolean } {
  const args = process.argv.slice(2);
  const noMemory = args.includes("--no-memory");
  const task =
    args.find((a) => !a.startsWith("--")) ??
    "Create a TypeScript function that validates email addresses and returns detailed error messages for each validation failure.";
  return { task, noMemory };
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); }));
}

function saveOutputs(finalOutputs: Map<string, { output: string }>) {
  // Print to console
  for (const [name, result] of finalOutputs) {
    console.log(`\n## ${name.toUpperCase()}\n`);
    console.log(result.output);
  }

  // Write to output directory
  const outputDir = path.join(process.cwd(), "output");
  fs.mkdirSync(outputDir, { recursive: true });

  for (const [name, result] of finalOutputs) {
    const filePath = path.join(outputDir, `${name}.md`);
    fs.writeFileSync(filePath, `# ${name.toUpperCase()} Output\n\n${result.output}\n`);
  }

  console.log(`\nOutputs saved to ${outputDir}/`);
}

async function main() {
  const { task, noMemory } = parseArgs();

  console.log(`\nTask: "${task}"`);
  console.log("=".repeat(60));

  // Check for cached results from a previous run of this exact task
  if (!noMemory) {
    const memory = new MemoryStore();
    const cached = memory.getCachedResults(task, agents.map((a) => a.name));

    if (cached.size === agents.length) {
      console.log(`\nThis task has already been completed. Cached results found for all ${cached.size} agents.`);

      // In non-interactive mode (piped input, CI), re-run by default
      if (!process.stdin.isTTY) {
        console.log("Non-interactive mode detected, re-running pipeline...\n");
        return runFresh(task);
      }

      const answer = await prompt("\nUse cached results? (y)es / (r)e-run / (f)resh run (no memory): ");

      if (answer === "y" || answer === "yes") {
        console.log("\nUsing cached results.\n");
        console.log("=".repeat(60));
        console.log("\nFinal outputs:\n");

        const finalOutputs = new Map<string, { output: string }>();
        for (const [name, record] of cached) {
          finalOutputs.set(name, { output: record.output });
        }
        saveOutputs(finalOutputs);
        return;
      }

      if (answer === "f" || answer === "fresh") {
        console.log("\nRe-running without memory...\n");
        return runFresh(task);
      }

      console.log("\nRe-running pipeline...\n");
    }
  }

  await runFresh(task, noMemory);
}

async function runFresh(task: string, noMemory = false) {
  const results = await runAutoResume(task, {
    agents,
    noMemory,
    onAgentComplete: (result: AgentResult) => {
      const icon = result.status === "success" ? "✓" : "↩";
      console.log(`${icon} [${result.agentName}] ${result.status}`);
      if (result.status === "needs_revision") {
        console.log(`  Feedback: ${result.feedback}`);
      }
    },
  });

  console.log("\n" + "=".repeat(60));
  console.log("\nFinal outputs:\n");

  // Collect the last successful output from each agent
  const finalOutputs = new Map<string, AgentResult>();
  for (const result of [...results].reverse()) {
    if (!finalOutputs.has(result.agentName) && result.status === "success") {
      finalOutputs.set(result.agentName, result);
    }
  }

  saveOutputs(finalOutputs);
}

main().catch((err) => {
  if (isPauseSignal(err)) {
    const runId = (err as { runId?: string }).runId;
    console.log(`\n⏸  Pipeline paused: ${err.message}`);
    if (err instanceof RateLimitError) {
      console.log(`   Resume after ${new Date(err.resumeAtMs).toISOString()}.`);
    }
    if (runId) {
      console.log(`   Checkpoint saved. Resume with:  npm run resume -- ${runId}`);
    }
    process.exit(0);
  }
  console.error("Pipeline failed:", err);
  process.exit(1);
});
