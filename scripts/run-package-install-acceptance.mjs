import { mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const primeRoot = process.env.PRIME_AGENT_ROOT;
if (!primeRoot) throw new Error("PRIME_AGENT_ROOT is required");
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "prime-ralph-package-install-"));
const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: sourceRoot, encoding: "utf8" });
if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
const packed = JSON.parse(pack.stdout)[0];
const tarball = join(temp, packed.filename);
const names = new Set(packed.files.map((entry) => entry.path));
for (const required of ["bin/prime-ralph.js", "src/init.js", "src/index.js", "src/specification.js", "src/workflow-extension.js", "templates/default/prepare/SKILL.md", "templates/default/spec-it-out/SKILL.md", "templates/beads/execute/SKILL.md", "templates/beads/spec-it-out/SKILL.md"]) {
  if (!names.has(required)) throw new Error(`packed artifact missing ${required}`);
}
const installRoot = join(temp, "install"); mkdirSync(installRoot);
function npmInstall() {
  const result = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installRoot, tarball], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`packed install failed: ${result.stderr}`);
}
npmInstall();
const project = join(temp, "project"); mkdirSync(project);
const cli = join(installRoot, "node_modules/.bin/prime-ralph");
const run = spawnSync(cli, ["init", "--project", project], { encoding: "utf8" });
if (run.status !== 0) throw new Error(`installed CLI failed: ${run.stderr}`);
const beforeUpdate = snapshot(project);
npmInstall();
const afterUpdate = snapshot(project);
if (beforeUpdate !== afterUpdate) throw new Error("package update mutated the initialized project");
const installedSpecification = await import(pathToFileURL(join(installRoot, "node_modules/prime-ralph/src/specification.js")).href);
const installedSkill = installedSpecification.loadSpecItOutSkill({ cwd: project });
if (!installedSkill.text.includes("prime-ralph-invocation-version: 1")) throw new Error("installed Slice 3 prompt contract is unavailable");
const { discoverAndLoadExtensions } = await import(pathToFileURL(join(primeRoot, "dist/core/extensions/loader.js")).href);
const agentDir = join(temp, "agent"); mkdirSync(agentDir);
const loaded = await discoverAndLoadExtensions([], project, agentDir);
const commandNames = [...(loaded.extensions[0]?.commands?.keys() ?? [])];
if (loaded.errors.length || loaded.extensions.length !== 1 || JSON.stringify(commandNames) !== JSON.stringify(["reset", "spec-it-out"])) throw new Error(`installed extension discovery failed: ${JSON.stringify(loaded.errors)}`);
console.log(JSON.stringify({ packedFiles: packed.files.length, binInstalled: true, projectUnchangedByPackageUpdate: true, extensionLoaded: true, specificationPromptCompatible: true, registeredCommands: commandNames }, null, 2));
rmSync(temp, { recursive: true, force: true });

function snapshot(root) {
  const hash = createHash("sha256");
  function visit(path, relative = "") {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name); const rel = relative ? `${relative}/${name}` : name; const stat = lstatSync(child);
      hash.update(`${rel}:${stat.mode}:`);
      if (stat.isSymbolicLink()) hash.update(`link:${readlinkSync(child)}`);
      else if (stat.isDirectory()) visit(child, rel);
      else hash.update(readFileSync(child));
    }
  }
  visit(root); return hash.digest("hex");
}
