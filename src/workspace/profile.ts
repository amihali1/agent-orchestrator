import fs from "fs";
import path from "path";

/** A verifier command, or null when the project has no such gate. */
export type CommandOrNull = string | null;

export interface ProjectProfile {
  name: string;
  /** Absolute path to the target repo. */
  path: string;
  stack: string;
  /** Real commands the Verifier runs, in order. null = skip that gate. */
  commands: {
    typecheck: CommandOrNull;
    lint: CommandOrNull;
    test: CommandOrNull;
    e2e: CommandOrNull;
  };
  /** Default globs (relative to `path`) used to gather context when the task names no files. */
  contextGlobs: string[];
}

const PROFILE_DIR = path.join(process.cwd(), "profiles");

/** Load and validate a project profile by name. */
export function loadProfile(name: string, dir = PROFILE_DIR): ProjectProfile {
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No profile "${name}" at ${file}`);
  }
  const profile = JSON.parse(fs.readFileSync(file, "utf-8")) as ProjectProfile;

  if (!profile.path || !fs.existsSync(profile.path)) {
    throw new Error(`Profile "${name}" points at a missing path: ${profile.path}`);
  }
  if (!profile.commands) throw new Error(`Profile "${name}" has no commands block`);
  return profile;
}
