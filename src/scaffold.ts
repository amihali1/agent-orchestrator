import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { MemoryRecord } from "./types";
import { extractFiles } from "./files";

const DB_PATH = path.join(process.cwd(), "memory.db");

function getLatestOutputs(db: Database.Database, task: string): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT agent_name, output FROM memories
       WHERE task = ?
       AND rowid IN (
         SELECT MAX(rowid) FROM memories WHERE task = ? GROUP BY agent_name
       )`
    )
    .all(task, task) as Pick<MemoryRecord, "agent_name" | "output">[];

  const outputs = new Map<string, string>();
  for (const row of rows) {
    outputs.set(row.agent_name, row.output);
  }
  return outputs;
}

async function main() {
  const projectName = process.argv[2];
  const task = process.argv[3];
  if (!projectName) {
    console.error('Usage: npm run scaffold <project-name> [task]');
    console.error('  If task is omitted, uses the most recent task from memory.');
    process.exit(1);
  }

  const projectDir = path.resolve(projectName);

  if (fs.existsSync(projectDir)) {
    console.error(`Directory "${projectDir}" already exists.`);
    process.exit(1);
  }

  // Read outputs from DB
  const db = new Database(DB_PATH);

  // Resolve which task to scaffold
  const resolvedTask = task
    ?? (db.prepare(`SELECT task FROM memories ORDER BY created_at DESC LIMIT 1`).get() as { task: string } | undefined)?.task;

  if (!resolvedTask) {
    console.error("No tasks found in memory. Run the pipeline first.");
    db.close();
    process.exit(1);
  }

  console.log(`Task: "${resolvedTask}"`);
  const outputs = getLatestOutputs(db, resolvedTask);
  db.close();

  const engineerOutput = outputs.get("engineer");
  if (!engineerOutput) {
    console.error("No engineer output found in memory. Run the pipeline first.");
    process.exit(1);
  }

  // Extract code files from engineer output
  const files = extractFiles(engineerOutput);
  if (files.size === 0) {
    console.error(
      "No file blocks found in engineer output. Expected '## File: path' headers with code blocks."
    );
    process.exit(1);
  }

  // Also extract from tester output if it has file blocks
  const testerOutput = outputs.get("tester");
  if (testerOutput) {
    const testFiles = extractFiles(testerOutput);
    for (const [filePath, content] of testFiles) {
      if (!files.has(filePath)) {
        files.set(filePath, content);
      }
    }
  }

  // Scaffold the project
  console.log(`\nScaffolding project at ${projectDir}\n`);
  fs.mkdirSync(projectDir, { recursive: true });

  for (const [filePath, content] of files) {
    const fullPath = path.join(projectDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    console.log(`  + ${filePath}`);
  }

  // Save design spec if available
  const designerOutput = outputs.get("designer");
  if (designerOutput) {
    const specPath = path.join(projectDir, "DESIGN.md");
    fs.writeFileSync(specPath, designerOutput + "\n");
    console.log("  + DESIGN.md");
  }

  // Save review if available
  const reviewerOutput = outputs.get("reviewer");
  if (reviewerOutput) {
    const reviewPath = path.join(projectDir, "REVIEW.md");
    fs.writeFileSync(reviewPath, reviewerOutput + "\n");
    console.log("  + REVIEW.md");
  }

  // Initialize git repo
  console.log("\nInitializing git repository...");
  try {
    execSync("git init", { cwd: projectDir, stdio: "inherit" });
  } catch {
    console.warn("  Warning: git init failed. You can initialize the repo manually.");
  }

  // Create a basic package.json if one wasn't generated
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    const pkg = {
      name: path.basename(projectDir),
      version: "0.1.0",
      private: true,
      scripts: {
        build: "tsc",
        test: "vitest run",
      },
      devDependencies: {
        typescript: "^5.0.0",
        vitest: "^3.0.0",
      },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log("  + package.json (generated)");
  }

  // Create tsconfig if not generated
  const tsconfigPath = path.join(projectDir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        outDir: "dist",
        rootDir: "src",
        declaration: true,
      },
      include: ["src"],
    };
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
    console.log("  + tsconfig.json (generated)");
  }

  console.log(`\nDone! Project scaffolded at ${projectDir}`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${projectName}`);
  console.log(`  npm install`);
  console.log(`  npm test`);
}

main().catch((err) => {
  console.error("Scaffold failed:", err);
  process.exit(1);
});
