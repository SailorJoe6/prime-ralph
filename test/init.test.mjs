import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CANONICAL_SKILLS, EXTENSION_ENTRY_RELATIVE_PATH, InitError, initializeProject } from "../src/init.js";

const packageEntry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const templateRoot = fileURLToPath(new URL("../templates", import.meta.url));
function project(prefix = "prime-ralph-init-") { return mkdtempSync(join(tmpdir(), prefix)); }
function init(cwd, options = {}, runtime = {}) { return initializeProject({ project: cwd, packageEntry, templateRoot, ...options }, runtime); }
function snapshot(cwd) {
  const result = {};
  for (const skill of CANONICAL_SKILLS) {
    const path = join(cwd, `.ralph/skills/${skill}/SKILL.md`);
    result[skill] = readFileSync(path, "utf8");
  }
  result.extension = readlinkSync(join(cwd, EXTENSION_ENTRY_RELATIVE_PATH));
  return result;
}

test("clean default init creates the exact project-local structure without activation", () => {
  const cwd = project(); let calls = 0;
  const result = init(cwd, {}, { runCommand() { calls += 1; throw new Error("unexpected command"); } });
  assert.equal(calls, 0);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.removed, []);
  assert.equal(lstatSync(join(cwd, EXTENSION_ENTRY_RELATIVE_PATH)).isSymbolicLink(), true);
  assert.equal(resolve(dirname(join(cwd, EXTENSION_ENTRY_RELATIVE_PATH)), readlinkSync(join(cwd, EXTENSION_ENTRY_RELATIVE_PATH))), dirname(packageEntry));
  for (const skill of CANONICAL_SKILLS) {
    assert.equal(readFileSync(join(cwd, `.ralph/skills/${skill}/SKILL.md`), "utf8"), readFileSync(join(templateRoot, `default/${skill}/SKILL.md`), "utf8"));
  }
  assert.equal(lstatSafe(join(cwd, ".agents")), undefined);
  for (const dir of [".ralph/plans/blocked", ".ralph/plans/future", ".ralph/plans/archive", ".ralph/logs"]) assert.equal(lstatSync(join(cwd, dir)).isDirectory(), true);
  assert.equal(result.created.some((path) => /goal|phase|provider/.test(path)), false);
});
test("repeated initialization and changed flags preserve all existing project artifacts", () => {
  const cwd = project(); init(cwd); const before = snapshot(cwd);
  writeFileSync(join(cwd, ".ralph/skills/prepare/SKILL.md"), "custom prepare\n");
  mkdirSync(join(cwd, ".beads"));
  const result = init(cwd, { beads: true });
  assert.equal(result.created.length, 0);
  assert.equal(readFileSync(join(cwd, ".ralph/skills/prepare/SKILL.md"), "utf8"), "custom prepare\n");
  const after = snapshot(cwd); after.prepare = before.prepare;
  assert.deepEqual(after, before);
});

test("default mode never infers Beads and explicit Beads fills only missing skills", () => {
  const cwd = project(); mkdirSync(join(cwd, ".beads"));
  let calls = 0; init(cwd, {}, { runCommand() { calls += 1; throw new Error("must not run bd"); } });
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(cwd, ".ralph/skills/execute/SKILL.md"), "utf8"), readFileSync(join(templateRoot, "default/execute/SKILL.md"), "utf8"));
  rmSync(join(cwd, ".ralph/skills/execute/SKILL.md"));
  init(cwd, { beads: true }, { runCommand() { calls += 1; throw new Error("existing state must not run bd"); } });
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(cwd, ".ralph/skills/execute/SKILL.md"), "utf8"), readFileSync(join(templateRoot, "beads/execute/SKILL.md"), "utf8"));
});

test("explicit Beads preflights and initializes before creating Ralph files", () => {
  const cwd = project(); const calls = [];
  const result = init(cwd, { beads: true }, { runCommand(command, args, commandCwd) {
    calls.push([command, args, commandCwd]);
    if (args[0] === "--version") return { status: 0, stdout: "bd" };
    mkdirSync(join(cwd, ".beads")); return { status: 0, stdout: "ok" };
  } });
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [["bd", ["--version"]], ["bd", ["init", "--skip-agents", "--skip-hooks"]]]);
  assert.equal(result.beadsInitialized, true);
  assert.match(readFileSync(join(cwd, ".ralph/skills/execute/SKILL.md"), "utf8"), /Beads/);
});

test("missing bd fails clearly before any Ralph mutation", () => {
  const cwd = project();
  assert.throws(() => init(cwd, { beads: true }, { runCommand() { return { status: null, error: { code: "ENOENT" } }; } }), /requires the bd command/);
  assert.equal(lstatSafe(join(cwd, ".ralph")), undefined);
});

test("custom skills and conflicting destinations are preserved while exact legacy links are removed", () => {
  const cwd = project(); init(cwd);
  const custom = join(cwd, ".ralph/skills/plan/SKILL.md"); writeFileSync(custom, "custom\n");
  mkdirSync(join(cwd, ".agents/skills"), { recursive: true });
  const wrong = join(cwd, ".agents/skills/execute"); symlinkSync("../../elsewhere", wrong, "dir");
  const legacy = join(cwd, ".agents/skills/plan"); symlinkSync(join(cwd, ".ralph/skills/plan"), legacy, "dir");
  const extension = join(cwd, EXTENSION_ENTRY_RELATIVE_PATH); rmSync(extension); mkdirSync(extension);
  const result = init(cwd);
  assert.equal(readFileSync(custom, "utf8"), "custom\n");
  assert.equal(readlinkSync(wrong), "../../elsewhere");
  assert.equal(lstatSafe(legacy), undefined);
  assert.deepEqual(result.removed, [".agents/skills/plan"]);
  assert.equal(lstatSync(extension).isDirectory(), true);
  assert.ok(result.warnings.some((warning) => warning.includes("execute")));
  assert.ok(result.warnings.some((warning) => warning.includes(EXTENSION_ENTRY_RELATIVE_PATH)));
});
test("repeated init removes all exact legacy links but preserves parent and unrelated entries", () => {
  const cwd = project(); init(cwd); mkdirSync(join(cwd, ".agents/skills"), { recursive: true });
  for (const skill of CANONICAL_SKILLS) symlinkSync(`../../.ralph/skills/${skill}`, join(cwd, `.agents/skills/${skill}`), "dir");
  symlinkSync("../../.ralph/skills/spec-it-out", join(cwd, ".agents/skills/spec-it-out-old"), "dir");
  writeFileSync(join(cwd, ".agents/skills/user-skill"), "user\n");
  const result = init(cwd);
  assert.deepEqual(result.removed, CANONICAL_SKILLS.map((skill) => `.agents/skills/${skill}`));
  for (const skill of CANONICAL_SKILLS) assert.equal(lstatSafe(join(cwd, `.agents/skills/${skill}`)), undefined);
  assert.equal(readlinkSync(join(cwd, ".agents/skills/spec-it-out-old")), "../../.ralph/skills/spec-it-out");
  assert.equal(readFileSync(join(cwd, ".agents/skills/user-skill"), "utf8"), "user\n");
  assert.equal(lstatSync(join(cwd, ".agents/skills")).isDirectory(), true);
});

test("legacy migration does not trust a conflicting canonical skill directory", () => {
  const cwd = project(); mkdirSync(join(cwd, ".ralph/skills"), { recursive: true });
  const outside = project("prime-ralph-external-skill-");
  symlinkSync(outside, join(cwd, ".ralph/skills/execute"), "dir");
  mkdirSync(join(cwd, ".agents/skills"), { recursive: true });
  const entry = join(cwd, ".agents/skills/execute"); symlinkSync(outside, entry, "dir");
  const result = init(cwd);
  assert.equal(readlinkSync(entry), outside);
  assert.deepEqual(result.removed, []);
  assert.ok(result.warnings.some((warning) => warning.includes(".ralph/skills/execute")));
});

test("legacy migration never follows .agents parent symlinks", () => {
  for (const parent of [".agents", ".agents/skills"]) {
    const cwd = project(); init(cwd); const outside = project("prime-ralph-agent-parent-");
    mkdirSync(join(outside, "skills"), { recursive: true });
    const externalEntry = parent === ".agents" ? join(outside, "skills/execute") : join(outside, "execute");
    symlinkSync(join(cwd, ".ralph/skills/execute"), externalEntry, "dir");
    if (parent === ".agents") symlinkSync(outside, join(cwd, parent), "dir");
    else { mkdirSync(join(cwd, ".agents")); symlinkSync(outside, join(cwd, parent), "dir"); }
    const result = init(cwd);
    assert.equal(lstatSync(externalEntry).isSymbolicLink(), true);
    assert.deepEqual(result.removed, []);
  }
});

test("conflicting parent symlinks are not followed outside the project", () => {
  const cwd = project(); const outside = project("prime-ralph-outside-");
  symlinkSync(outside, join(cwd, ".ralph"), "dir");
  const result = init(cwd);
  assert.equal(lstatSafe(join(outside, "skills")), undefined);
  assert.ok(result.warnings.some((warning) => warning.includes(".ralph")));
  assert.equal(lstatSafe(join(cwd, ".agents")), undefined);
});
test("stealth adds only newly created leaf artifacts and supports nested project roots", () => {
  const repo = project(); spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  const cwd = join(repo, "nested project"); mkdirSync(cwd);
  const result = init(cwd, { stealth: true });
  assert.equal(result.warnings.length, 0);
  const exclude = readFileSync(join(repo, ".git/info/exclude"), "utf8");
  assert.match(exclude, /\/nested project\/\.prime\/agent\/extensions\/prime-ralph/);
  assert.match(exclude, /\/nested project\/\.ralph\/skills\/prepare\/SKILL\.md/);
  assert.doesNotMatch(exclude, /\/nested project\/\.ralph\/$/m);
  const before = exclude; const again = init(cwd, { stealth: true });
  assert.equal(again.created.length, 0);
  assert.equal(readFileSync(join(repo, ".git/info/exclude"), "utf8"), before);
});

test("stealth outside Git warns and initialization still succeeds", () => {
  const cwd = project(); const result = init(cwd, { stealth: true });
  assert.ok(result.warnings.some((warning) => warning.includes("not a Git worktree")));
  assert.equal(lstatSync(join(cwd, EXTENSION_ENTRY_RELATIVE_PATH)).isSymbolicLink(), true);
});


test("combined Beads stealth reconciles bd side effects and writes only granular local excludes", () => {
  const repo = project(); const gitDir = join(repo, ".git"); mkdirSync(join(gitDir, "info"), { recursive: true });
  const excludePath = join(gitDir, "info/exclude"); writeFileSync(excludePath, "existing-rule");
  writeFileSync(join(repo, ".gitignore"), "user-ignore\n");
  const calls = []; let beadsRole = "viewer";
  const result = init(repo, { beads: true, stealth: true }, { runCommand(command, args, cwd) {
    calls.push([command, args]);
    if (command === "bd" && args[0] === "--version") return { status: 0, stdout: "bd" };
    if (command === "bd") {
      mkdirSync(join(repo, ".beads")); beadsRole = "maintainer";
      writeFileSync(join(repo, ".gitignore"), "bd-overwrite\n");
      writeFileSync(excludePath, "existing-rule\n.beads/\n**/RECOVERY*.md\n**/SESSION*.md\n");
      return { status: 0, stdout: "initialized" };
    }
    if (args.includes("--show-toplevel")) return { status: 0, stdout: `${repo}\n` };
    if (args.includes("--git-path")) return { status: 0, stdout: `${excludePath}\n` };
    if (args.includes("--get-all")) return { status: beadsRole === undefined ? 1 : 0, stdout: beadsRole === undefined ? "" : `${beadsRole}\n` };
    if (args.includes("--unset-all")) { beadsRole = undefined; return { status: 0 }; }
    if (args.includes("--add")) { beadsRole = args.at(-1); return { status: 0 }; }
    return { status: 2, stderr: "unexpected command" };
  } });
  assert.equal(result.beadsInitialized, true);
  assert.deepEqual(calls.find(([command, args]) => command === "bd" && args[0] === "init")?.[1], ["init", "--setup-exclude", "--skip-agents", "--skip-hooks"]);
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), "user-ignore\n");
  const exclude = readFileSync(excludePath, "utf8");
  assert.match(exclude, /^existing-rule\n/);
  assert.match(exclude, /\/\.beads\//);
  assert.doesNotMatch(exclude, /RECOVERY|SESSION/);
  assert.equal(beadsRole, "viewer");
});

test("stealth escapes Git-ignore metacharacters and preserves an exclude without final newline", () => {
  const repo = project(); spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  const cwd = join(repo, "[#]!*? folder "); mkdirSync(cwd);
  const excludePath = join(repo, ".git/info/exclude"); writeFileSync(excludePath, "base-rule");
  init(cwd, { stealth: true });
  const exclude = readFileSync(excludePath, "utf8");
  assert.match(exclude, /^base-rule\n/);
  assert.match(exclude, /\/\\\[#\\\]!\\\*\\\? folder \/\.ralph\/skills\/prepare\/SKILL\.md/);
});

test("stealth distinguishes a missing git command from a non-worktree", () => {
  const cwd = project(); let calls = 0;
  const result = init(cwd, { stealth: true }, { runCommand() { calls += 1; return { status: null, error: { code: "ENOENT" } }; } });
  assert.equal(calls, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("git command is unavailable")));
});


test("extension conflicts of every ordinary kind are preserved", () => {
  for (const kind of ["file", "directory", "wrong-symlink", "dangling-symlink"]) {
    const cwd = project(); mkdirSync(join(cwd, ".prime/agent/extensions"), { recursive: true });
    const path = join(cwd, EXTENSION_ENTRY_RELATIVE_PATH);
    if (kind === "file") writeFileSync(path, "custom extension\n");
    else if (kind === "directory") mkdirSync(path);
    else if (kind === "wrong-symlink") { const target = join(cwd, "other"); mkdirSync(target); symlinkSync(target, path, "dir"); }
    else symlinkSync(join(cwd, "missing"), path, "dir");
    const before = kind === "file" ? readFileSync(path, "utf8") : kind === "directory" ? "directory" : readlinkSync(path);
    const result = init(cwd);
    const after = kind === "file" ? readFileSync(path, "utf8") : kind === "directory" ? "directory" : readlinkSync(path);
    assert.equal(after, before, kind);
    assert.ok(result.warnings.some((warning) => warning.includes(EXTENSION_ENTRY_RELATIVE_PATH)), kind);
  }
});

test("canonical skill conflicts and non-legacy agent entries are preserved", () => {
  for (const kind of ["directory", "live-symlink", "dangling-symlink"]) {
    const cwd = project(); mkdirSync(join(cwd, ".ralph/skills/execute"), { recursive: true });
    const skillPath = join(cwd, ".ralph/skills/execute/SKILL.md");
    if (kind === "directory") mkdirSync(skillPath);
    else if (kind === "live-symlink") { const source = join(cwd, "custom-skill"); writeFileSync(source, "custom\n"); symlinkSync(source, skillPath); }
    else symlinkSync(join(cwd, "missing-skill"), skillPath);
    const before = kind === "directory" ? "directory" : readlinkSync(skillPath);
    const result = init(cwd);
    const after = kind === "directory" ? "directory" : readlinkSync(skillPath);
    assert.equal(after, before, kind);
    assert.equal(lstatSafe(join(cwd, ".agents")), undefined);
    assert.ok(result.warnings.some((warning) => warning.includes("execute/SKILL.md")), kind);
  }
  for (const kind of ["file", "directory", "wrong-symlink", "dangling-symlink"]) {
    const cwd = project(); init(cwd); mkdirSync(join(cwd, ".agents/skills"), { recursive: true });
    const path = join(cwd, ".agents/skills/execute");
    if (kind === "file") writeFileSync(path, "custom\n");
    else if (kind === "directory") mkdirSync(path);
    else if (kind === "wrong-symlink") { const target = join(cwd, "other"); mkdirSync(target); symlinkSync(target, path, "dir"); }
    else symlinkSync(join(cwd, "missing"), path, "dir");
    const before = kind === "file" ? readFileSync(path, "utf8") : kind === "directory" ? "directory" : readlinkSync(path);
    const result = init(cwd); const after = kind === "file" ? readFileSync(path, "utf8") : kind === "directory" ? "directory" : readlinkSync(path);
    assert.equal(after, before, kind);
    if (kind.includes("symlink")) assert.ok(result.warnings.some((warning) => warning.includes(".agents/skills/execute")), kind);
  }
});
test("conflicting prime parent is preserved and blocks only its branch", () => {
  for (const kind of ["file", "symlink"]) {
    const cwd = project(); const path = join(cwd, ".prime");
    if (kind === "file") writeFileSync(path, "custom\n");
    else { const outside = project("prime-ralph-parent-"); symlinkSync(outside, path, "dir"); }
    const before = kind === "file" ? readFileSync(path, "utf8") : readlinkSync(path);
    const result = init(cwd); const after = kind === "file" ? readFileSync(path, "utf8") : readlinkSync(path);
    assert.equal(after, before); assert.ok(result.warnings.some((warning) => warning.includes(".prime")));
    assert.equal(lstatSafe(join(cwd, ".agents")), undefined);
  }
});
test("Beads failures preserve partial state and never begin Ralph mutation", () => {
  for (const failure of [
    { status: 7, stderr: "injected failure" },
    { status: null, signal: "SIGTERM", stderr: "terminated" },
  ]) {
    const cwd = project();
    assert.throws(() => init(cwd, { beads: true }, { runCommand(_command, args) {
      if (args[0] === "--version") return { status: 0 };
      mkdirSync(join(cwd, ".beads")); return failure;
    } }), /bd init failed/);
    assert.equal(lstatSync(join(cwd, ".beads")).isDirectory(), true);
    assert.equal(lstatSafe(join(cwd, ".ralph")), undefined);
  }
  for (const kind of ["file", "dangling-symlink"]) {
    const cwd = project(); const path = join(cwd, ".beads");
    if (kind === "file") writeFileSync(path, "custom\n"); else symlinkSync(join(cwd, "missing"), path);
    assert.throws(() => init(cwd, { beads: true }), /not a directory/);
    assert.equal(kind === "file" ? readFileSync(path, "utf8") : readlinkSync(path), kind === "file" ? "custom\n" : join(cwd, "missing"));
  }
});

test("missing Beads template falls back to the matching default template", () => {
  const cwd = project(); mkdirSync(join(cwd, ".beads"));
  const customTemplates = project("prime-ralph-templates-"); cpSync(templateRoot, customTemplates, { recursive: true });
  rmSync(join(customTemplates, "beads/blocked/SKILL.md"));
  init(cwd, { beads: true, templateRoot: customTemplates });
  assert.equal(readFileSync(join(cwd, ".ralph/skills/blocked/SKILL.md"), "utf8"), readFileSync(join(customTemplates, "default/blocked/SKILL.md"), "utf8"));
});

function lstatSafe(path) { try { return lstatSync(path); } catch { return undefined; } }
