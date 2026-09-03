import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const entry = await import(pathToFileURL(new URL("../src/index.js", import.meta.url).pathname).href);
if (typeof entry.default !== "function") throw new Error("default extension entry is not callable");
for (const mode of ["text", "json", "rpc", "acp", "daemon"]) {
  const commands = new Map();
  entry.default({ mode, registerCommand: (name, command) => commands.set(name, command), on() {}, appendEntry() {}, sendMessage() {} });
  if (!commands.has("reset") || commands.has("clear")) throw new Error(`reset command registration failed in ${mode} smoke`);
}
for (const exportName of ["observability", "ralph-context", "reset-context", "reset-extension", "reset-skill", "cycle-coordinator", "continuation-adapter", "skill-config", "phase-runtime", "beads-coordination", "coordination-runtime", "bd-cli-adapter", "goal-lifecycle", "cache-analysis", "diagnostics"]) await import(new URL(`../src/${exportName}.js`, import.meta.url));
console.log("mode/export smoke OK: text, json, rpc, acp, daemon");
if (packageJson.peerDependencies?.["prime-agent"] !== "0.9.1") throw new Error("unsupported peer range");
console.log(`package check OK: ${packageJson.name}@${packageJson.version}`);
