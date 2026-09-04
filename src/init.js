import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync,
  realpathSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const CANONICAL_SKILLS = ["prepare", "spec-it-out", "plan", "execute", "blocked"];
export const EXTENSION_ENTRY_RELATIVE_PATH = ".prime/agent/extensions/prime-ralph";
const PROJECT_DIRECTORIES = [
  ".prime", ".prime/agent", ".prime/agent/extensions",
  ".ralph", ".ralph/skills", ".ralph/plans", ".ralph/plans/blocked",
  ".ralph/plans/future", ".ralph/plans/archive", ".ralph/logs",
  ".agents", ".agents/skills",
];

export class InitError extends Error {
  constructor(message) { super(message); this.name = "InitError"; }
}

function defaultRun(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function pathKind(path) {
  if (!existsSync(path)) {
    try { lstatSync(path); } catch { return "missing"; }
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function normalize(relativePath) { return relativePath.replaceAll("\\", "/"); }

export function initializeProject(options = {}, runtime = {}) {
  const project = resolve(options.project ?? process.cwd());
  const beads = options.beads === true;
  const stealth = options.stealth === true;
  const packageEntry = resolve(options.packageEntry ?? fileURLToPath(new URL("./index.js", import.meta.url)));
  const templateRoot = resolve(options.templateRoot ?? fileURLToPath(new URL("../templates", import.meta.url)));
  const run = runtime.runCommand ?? defaultRun;
  const created = [];
  const preserved = [];
  const warnings = [];
  const readySkills = new Set();

  if (pathKind(project) !== "directory") throw new InitError(`Project path is not a directory: ${project}`);
  if (stealth && /[\r\n]/.test(project)) throw new InitError("--stealth cannot represent a project path containing a newline");
  if (pathKind(packageEntry) !== "file") throw new InitError(`Package extension entry is unavailable: ${packageEntry}`);

  const beadsPath = join(project, ".beads");
  const beadsKind = pathKind(beadsPath);
  if (beads && beadsKind !== "missing" && beadsKind !== "directory") {
    throw new InitError("Cannot initialize Beads because .beads exists and is not a directory");
  }
  if (beads && beadsKind === "missing") {
    const version = run("bd", ["--version"], project);
    if (version?.error?.code === "ENOENT" || version?.status !== 0) {
      throw new InitError("--beads requires the bd command, but it is unavailable");
    }
    const gitignoreSnapshot = stealth ? snapshotFile(join(project, ".gitignore")) : undefined;
    const excludePath = stealth ? resolveGitExcludePath(project, run) : undefined;
    const excludeSnapshot = excludePath ? snapshotFile(excludePath) : undefined;
    const beadsRoleSnapshot = excludePath ? snapshotGitConfigValues(project, "beads.role", run) : undefined;
    const args = ["init", ...(excludePath ? ["--setup-exclude"] : []), "--skip-agents", "--skip-hooks"];
    const result = run("bd", args, project);
    let reconciliationError;
    if (stealth) {
      try { restoreFile(join(project, ".gitignore"), gitignoreSnapshot); } catch (error) { reconciliationError ??= error; }
      try { if (excludePath) restoreFile(excludePath, excludeSnapshot); } catch (error) { reconciliationError ??= error; }
      try { if (beadsRoleSnapshot) restoreGitConfigValues(project, "beads.role", beadsRoleSnapshot, run); } catch (error) { reconciliationError ??= error; }
    }
    if (reconciliationError) throw new InitError(`Could not reconcile Beads stealth side effects: ${reconciliationError.message}`);
    if (result?.status !== 0) {
      throw new InitError(`bd init failed: ${String(result?.stderr ?? "unknown error").trim()}`);
    }
    if (pathKind(beadsPath) === "directory") created.push(".beads/");
  }

  const ensureDirectory = (relativePath) => {
    const absolutePath = join(project, relativePath);
    const kind = pathKind(absolutePath);
    if (kind === "missing") {
      mkdirSync(absolutePath);
      created.push(`${normalize(relativePath)}/`);
      return true;
    }
    if (kind === "directory") {
      preserved.push(`${normalize(relativePath)}/`);
      return true;
    }
    warnings.push(`Preserved conflicting ${kind}: ${normalize(relativePath)}`);
    return false;
  };

  const directoryReady = new Map();
  for (const directory of PROJECT_DIRECTORIES) {
    const parent = dirname(directory);
    const parentReady = parent === "." || directoryReady.get(normalize(parent)) !== false;
    directoryReady.set(normalize(directory), parentReady && ensureDirectory(directory));
  }

  if (directoryReady.get(".prime/agent/extensions")) {
    const entryPath = join(project, EXTENSION_ENTRY_RELATIVE_PATH);
    const packageExtensionDirectory = dirname(packageEntry);
    const kind = pathKind(entryPath);
    let equivalent = false;
    if (kind === "symlink") {
      try { equivalent = realpathSync(entryPath) === realpathSync(packageExtensionDirectory); } catch { equivalent = false; }
    }
    if (kind === "missing") {
      const target = normalize(relative(dirname(entryPath), packageExtensionDirectory));
      symlinkSync(target, entryPath, "dir");
      created.push(EXTENSION_ENTRY_RELATIVE_PATH);
    } else if (equivalent) preserved.push(EXTENSION_ENTRY_RELATIVE_PATH);
    else warnings.push(`Preserved conflicting ${kind}: ${EXTENSION_ENTRY_RELATIVE_PATH}`);
  }

  if (directoryReady.get(".ralph/skills")) {
    for (const skill of CANONICAL_SKILLS) {
      const skillDir = `.ralph/skills/${skill}`;
      if (!ensureDirectory(skillDir)) continue;
      const target = `${skillDir}/SKILL.md`;
      const targetPath = join(project, target);
      const kind = pathKind(targetPath);
      if (kind === "missing") {
        const beadsTemplate = join(templateRoot, "beads", skill, "SKILL.md");
        const variant = beads && pathKind(beadsTemplate) === "file" ? "beads" : "default";
        const template = join(templateRoot, variant, skill, "SKILL.md");
        if (pathKind(template) !== "file") throw new InitError(`Missing bundled ${variant} template for ${skill}`);
        writeFileSync(targetPath, readFileSync(template), { flag: "wx" });
        created.push(target);
        readySkills.add(skill);
      } else if (kind === "file") {
        preserved.push(target);
        readySkills.add(skill);
      } else warnings.push(`Preserved conflicting ${kind}: ${target}`);
    }
  }

  if (directoryReady.get(".agents/skills")) {
    for (const skill of CANONICAL_SKILLS) {
      if (!readySkills.has(skill)) {
        warnings.push(`Skipped skill entrypoint because canonical skill is unavailable: .agents/skills/${skill}`);
        continue;
      }
      const link = `.agents/skills/${skill}`;
      const linkPath = join(project, link);
      const canonical = join(project, `.ralph/skills/${skill}`);
      const kind = pathKind(linkPath);
      if (kind === "missing") {
        symlinkSync(`../../.ralph/skills/${skill}`, linkPath, "dir");
        created.push(link);
      } else if (kind === "symlink") {
        let equivalent = false;
        try { equivalent = realpathSync(linkPath) === realpathSync(canonical); } catch { equivalent = false; }
        if (equivalent) preserved.push(link);
        else warnings.push(`Preserved conflicting symlink: ${link}`);
      } else warnings.push(`Preserved conflicting ${kind}: ${link}`);
    }
  }

  if (stealth) applyStealth(project, created, warnings, run);
  return { project, created, preserved, warnings, beadsInitialized: beads && created.includes(".beads/") };
}


function snapshotFile(path) {
  const kind = pathKind(path);
  if (kind === "missing") return { exists: false };
  if (kind !== "file") throw new InitError(`Cannot safely preserve non-file path during --stealth: ${path}`);
  return { exists: true, content: readFileSync(path) };
}

function restoreFile(path, snapshot) {
  if (!snapshot) return;
  if (snapshot.exists) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, snapshot.content);
  } else if (existsSync(path)) rmSync(path, { force: true });
}

function snapshotGitConfigValues(project, key, run) {
  const result = run("git", ["config", "--local", "--get-all", key], project);
  if (result?.status === 1) return [];
  if (result?.status !== 0) throw new InitError(`Cannot safely snapshot local Git configuration: ${key}`);
  const output = String(result.stdout ?? "");
  return output ? output.replace(/\n$/, "").split("\n") : [];
}

function restoreGitConfigValues(project, key, values, run) {
  const unset = run("git", ["config", "--local", "--unset-all", key], project);
  if (unset?.status !== 0 && unset?.status !== 5) throw new InitError(`Cannot restore local Git configuration: ${key}`);
  for (const value of values) {
    const added = run("git", ["config", "--local", "--add", key, value], project);
    if (added?.status !== 0) throw new InitError(`Cannot restore local Git configuration: ${key}`);
  }
}

function resolveGitExcludePath(project, run) {
  const result = run("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], project);
  if (result?.status !== 0) return undefined;
  const value = String(result.stdout ?? "").trim();
  return value ? (isAbsolute(value) ? value : resolve(project, value)) : undefined;
}

function escapeGitIgnorePath(path) {
  if (path.includes("\r") || path.includes("\n") || path.includes("\0")) throw new InitError("--stealth cannot represent a path containing a newline or NUL");
  return path.replaceAll("\\", "\\\\").replace(/([*?\[\]])/g, "\\$1");
}

function applyStealth(project, created, warnings, run) {
  const rootResult = run("git", ["rev-parse", "--show-toplevel"], project);
  if (rootResult?.error?.code === "ENOENT") {
    warnings.push("--stealth requested, but the git command is unavailable; no exclude file was changed");
    return;
  }
  if (rootResult?.status !== 0) {
    warnings.push("--stealth requested, but the project is not a Git worktree; no exclude file was changed");
    return;
  }
  const pathResult = run("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], project);
  if (pathResult?.status !== 0) {
    warnings.push("--stealth could not resolve the Git local exclude file; no exclude file was changed");
    return;
  }
  const worktreeRoot = String(rootResult.stdout ?? "").trim();
  const excludePathRaw = String(pathResult.stdout ?? "").trim();
  if (!worktreeRoot || !excludePathRaw) {
    warnings.push("--stealth could not resolve the Git local exclude file; no exclude file was changed");
    return;
  }
  const excludePath = isAbsolute(excludePathRaw) ? excludePathRaw : resolve(project, excludePathRaw);
  const projectPrefix = normalize(relative(worktreeRoot, project));
  const existingText = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const existingLines = existingText.split(/\r?\n/);
  const additions = [...new Set(created
    .filter((path) => !path.endsWith("/") || path === ".beads/")
    .map((path) => `/${escapeGitIgnorePath(projectPrefix ? `${projectPrefix}/${path}` : path)}`))]
    .filter((line) => !existingLines.includes(line));
  if (!additions.length) return;
  mkdirSync(dirname(excludePath), { recursive: true });
  appendFileSync(excludePath, `${existingText && !existingText.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`);
}
