import fs from "fs";
import path from "path";
import fg from "fast-glob";
import { ProjectProfile } from "./profile";

export interface GatheredFile {
  /** Path relative to the repo root. */
  path: string;
  content: string;
}

const DEFAULT_MAX_BYTES = 200_000;

/**
 * Read the files the engineer needs as context. Uses the task-specified `files`
 * (globs or paths) when given, else the profile's contextGlobs. Enforces a total
 * byte cap so a broad glob can't blow the token budget — this becomes the stable
 * cached prefix on the engineer's calls.
 */
export async function gatherContext(
  profile: ProjectProfile,
  files?: string[],
  maxBytes = Number(process.env.WORKSPACE_CONTEXT_MAX_BYTES) || DEFAULT_MAX_BYTES
): Promise<GatheredFile[]> {
  const patterns = files && files.length > 0 ? files : profile.contextGlobs;
  const matches = await fg(patterns, {
    cwd: profile.path,
    onlyFiles: true,
    dot: false,
    ignore: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/out/**"],
  });
  matches.sort();

  const gathered: GatheredFile[] = [];
  let total = 0;
  for (const rel of matches) {
    const abs = path.join(profile.path, rel);
    const content = fs.readFileSync(abs, "utf-8");
    total += Buffer.byteLength(content, "utf-8");
    if (total > maxBytes) {
      console.warn(`  context cap ${maxBytes}B reached — ${gathered.length} of ${matches.length} files included`);
      break;
    }
    gathered.push({ path: rel, content });
  }
  return gathered;
}

/** Render gathered files into a single text block for injection as the cached prefix. */
export function renderContext(files: GatheredFile[]): string {
  if (files.length === 0) return "";
  return (
    `# Existing repository files (current contents)\n\n` +
    files.map((f) => `## File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")
  );
}

const IGNORE = [
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/out/**",
  "**/.git/**",
  // Build/cache dirs (Unity, VS) — noise that would crowd out real source in the cap.
  "**/Library/**",
  "**/Temp/**",
  "**/Logs/**",
  "**/obj/**",
  "**/.vs/**",
];
const README_MAX_BYTES = 8_000;

/**
 * List repo file paths (no contents) for the planner — cheap, structural context.
 * Same ignores as gatherContext, sorted, capped at `maxFiles`.
 */
export async function listRepoFiles(profile: ProjectProfile, maxFiles = 500): Promise<string[]> {
  const matches = await fg("**/*", {
    cwd: profile.path,
    onlyFiles: true,
    dot: false,
    ignore: IGNORE,
  });
  matches.sort();
  return matches.slice(0, maxFiles);
}

/** Render the planner's cached prefix: a repo file list plus README (truncated) if present. */
export function renderPlanContext(paths: string[], readme?: string): string {
  const parts = [
    `# Repository file list (${paths.length} path(s))\n` + paths.map((p) => `- ${p}`).join("\n"),
  ];
  if (readme && readme.trim()) {
    parts.push(`# README\n\`\`\`\n${readme.slice(0, README_MAX_BYTES)}\n\`\`\``);
  }
  return parts.join("\n\n");
}
