import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { pathToFileURL } from "node:url";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const entry = await import(pathToFileURL(new URL("../src/index.js", import.meta.url).pathname).href);
if (typeof entry.default !== "function") throw new Error("default extension entry is not callable");
for (const mode of ["text", "json", "rpc", "acp", "daemon"]) {
  const commands = new Map();
  entry.default({ mode, registerCommand: (name, command) => commands.set(name, command), on() {}, appendEntry() {}, sendMessage() {} });
  if (JSON.stringify([...commands.keys()]) !== JSON.stringify(["reset", "spec-it-out", "plan"]) || commands.has("clear")) throw new Error(`Slice 4 command registration failed in ${mode} smoke`);
}
for (const exportName of ["observability", "ralph-context", "reset-context", "reset-extension", "reset-skill", "specification", "planning", "workflow-extension", "cycle-coordinator", "continuation-adapter", "skill-config", "phase-runtime", "beads-coordination", "coordination-runtime", "bd-cli-adapter", "goal-lifecycle", "cache-analysis", "diagnostics", "init", "cli"]) await import(new URL(`../src/${exportName}.js`, import.meta.url));
if (packageJson.bin?.["prime-ralph"] !== "bin/prime-ralph.js") throw new Error("initializer bin is not declared");
await access(new URL("../bin/prime-ralph.js", import.meta.url), constants.X_OK);
const forbiddenTerms = [
  ["sailor", "joe"].join(""),
  ["openclaw", "-setup"].join(""),
  ["/", "home", "/"].join(""),
  ["~/", ".local", "/share/", "ralph"].join(""),
];
for (const variant of ["default", "beads"]) for (const skill of ["prepare", "spec-it-out", "plan", "execute", "blocked"]) {
  const text = await readFile(new URL(`../templates/${variant}/${skill}/SKILL.md`, import.meta.url), "utf8");
  if (!text.includes(`name: ${skill}`)) throw new Error(`invalid ${variant}/${skill} template`);
  if (forbiddenTerms.some((term) => text.toLowerCase().includes(term))) throw new Error(`non-independent ${variant}/${skill} template`);
}
console.log("mode/export smoke OK: text, json, rpc, acp, daemon");
if (packageJson.peerDependencies?.["prime-agent"] !== "0.9.1") throw new Error("unsupported peer range");

async function scanTree(url) {
  for (const entry of await readdir(url, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, url);
    if (entry.isDirectory()) await scanTree(child);
    else {
      const text = await readFile(child, "utf8");
      const found = forbiddenTerms.find((term) => text.toLowerCase().includes(term));
      if (found) throw new Error(`non-independent packaged text in ${child.pathname}`);
    }
  }
}
for (const root of ["bin", "src", "templates", "scripts", "docs"]) await scanTree(new URL(`../${root}/`, import.meta.url));
for (const file of ["README.md", "package.json"]) {
  const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const found = forbiddenTerms.find((term) => text.toLowerCase().includes(term));
  if (found) throw new Error(`non-independent packaged text in ${file}`);
}
console.log("package independence scan OK");
for (const artifactName of ["spec-it-out-model-acceptance.json", "plan-model-acceptance.json"]) {
  const artifactUrl = new URL(`../docs/acceptance/${artifactName}`, import.meta.url);
  try {
    const artifact = JSON.parse(await readFile(artifactUrl, "utf8"));
    if (!Array.isArray(artifact.results) || artifact.results.length === 0 || artifact.results.some((result) => result.verdict !== "pass")) throw new Error(`${artifactName} contains a missing or failed verdict`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
console.log("model acceptance artifacts OK");
console.log(`package check OK: ${packageJson.name}@${packageJson.version}`);
