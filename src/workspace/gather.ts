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
