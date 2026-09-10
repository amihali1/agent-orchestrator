import "dotenv/config";
import fs from "fs";
import { plan } from "./workspace/planner";

function usage(): never {
  console.error(`Usage: npm run plan -- <project> "<goal>" [--out <file>]`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, out };
}

async function main() {
  const { positional, out } = parseArgs(process.argv.slice(2));
  const [project, goal] = positional;
  if (!project || !goal) usage();

  console.log(`Planning: ${project}\nGoal: ${goal}\n`);
  const { tasks, tokens } = await plan(project, goal);

  console.log("Tasks:");
  tasks.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log(`\nJSON:\n${JSON.stringify(tasks, null, 2)}`);

  if (out) {
    fs.writeFileSync(out, JSON.stringify(tasks, null, 2) + "\n");
    console.log(`\nWrote ${tasks.length} task(s) to ${out}`);
    console.log(`Run them with:  npm run backlog -- ${project} ${out}`);
  }

  console.log(`\nplanning tokens: ${tokens.run} billable (Claude) · ${tokens.local} local (Ollama, free)`);
}

main().catch((err) => {
  console.error("Plan failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
