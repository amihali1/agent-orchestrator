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

/**
 * Absolute path to the in-repo gate-scripts directory. Committed profiles reference
 * gate scripts via the `${GATES}` token so they stay portable across machines; it's
 * expanded to this path at load time.
 */
export function gatesDir(dir = PROFILE_DIR): string {
  return path.join(dir, "gates");
}

/** Expand the `${GATES}` token in a command string to the absolute gate-scripts dir. */
function expandGates(command: CommandOrNull, dir: string): CommandOrNull {
  if (!command) return command;
  return command.replace(/\$\{GATES\}/g, gatesDir(dir));
}

/** Path a profile is stored at. */
export function profilePath(name: string, dir = PROFILE_DIR): string {
  return path.join(dir, `${name}.json`);
}

/** Write a profile to `<dir>/<name>.json` (used by bootstrap to register a new project). */
export function saveProfile(name: string, profile: ProjectProfile, dir = PROFILE_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = profilePath(name, dir);
  fs.writeFileSync(file, JSON.stringify(profile, null, 2) + "\n");
  return file;
}

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

  // Expand ${GATES} in every gate command so committed profiles stay machine-portable.
  for (const gate of Object.keys(profile.commands) as (keyof ProjectProfile["commands"])[]) {
    profile.commands[gate] = expandGates(profile.commands[gate], dir);
  }
  return profile;
}
