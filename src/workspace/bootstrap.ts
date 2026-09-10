import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { applyFiles, initRepo, commitAll } from "./apply";
import { saveProfile, ProjectProfile } from "./profile";
import { verify } from "./verifier";
import { TEMPLATES } from "./templates";

export interface BootstrapOptions {
  base?: string;
  template?: string;
  /** Run `npm install` in the new repo (default true). */
  install?: boolean;
  /** Run the baseline gates after install to confirm a green start (default true). */
  verifyBaseline?: boolean;
  /** Where to write the profile JSON (default PROFILE_DIR). */
  profileDir?: string;
}

export interface BootstrapResult {
  path: string;
  profileName: string;
  stack: string;
  profile: ProjectProfile;
  installed: boolean;
  baselineOk?: boolean;
}

const DEFAULT_BASE = process.env.BOOTSTRAP_BASE || "C:/Dev";

/**
 * Turn nothing into a minimal, gate-green git repo + registered profile: write a stack
 * skeleton, `git init` + initial commit, optionally `npm install`, save the profile,
 * and (optionally) confirm the baseline gates pass. After this the plan/backlog spine
 * can operate on the project like any existing repo.
 */
export async function bootstrap(name: string, opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid project name "${name}" (letters, digits, . _ - only).`);
  }
  const templateName = opts.template ?? "ts-node";
  const template = TEMPLATES[templateName];
  if (!template) {
    throw new Error(`Unknown template "${templateName}". Available: ${Object.keys(TEMPLATES).join(", ")}`);
  }

  const target = path.resolve(opts.base ?? DEFAULT_BASE, name);
  if (fs.existsSync(target)) throw new Error(`Target already exists: ${target}`);

  console.log(`\nBootstrap: ${name} (${templateName}) @ ${target}`);
  fs.mkdirSync(target, { recursive: true });

  const written = applyFiles(target, new Map(Object.entries(template.files(name))));
  console.log(`  wrote ${written.length} file(s)`);

  initRepo(target);

  // Install BEFORE the initial commit so package-lock.json lands in it — otherwise the
  // fresh repo's tree is dirty (untracked lockfile) and the backlog's clean-tree check fails.
  const install = opts.install ?? true;
  let installed = false;
  if (install) {
    console.log(`  npm install ...`);
    execFileSync("npm", ["install"], { cwd: target, stdio: "inherit", shell: true });
    installed = true;
  }

  const commit = commitAll(target, `chore: bootstrap ${templateName} project`);
  console.log(`  git init + initial commit ${commit}`);

  const profile = template.profile(name, target);
  const profileFile = saveProfile(name, profile, opts.profileDir);
  console.log(`  profile → ${profileFile}`);

  let baselineOk: boolean | undefined;
  if ((opts.verifyBaseline ?? true) && installed) {
    console.log(`  verifying baseline gates ...`);
    const v = verify(profile);
    baselineOk = v.ok;
    if (!v.ok) {
      const failed = v.gates.filter((g) => !g.ok).map((g) => g.gate).join(", ");
      throw new Error(`Baseline gates failed (${failed}) — template "${templateName}" is broken.`);
    }
    console.log(`  ✓ baseline gates green`);
  }

  return { path: target, profileName: name, stack: template.stack, profile, installed, baselineOk };
}
