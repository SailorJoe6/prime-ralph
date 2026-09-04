import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CANONICAL_COMMAND_NAMES = new Set(["prepare", "spec-it-out", "plan", "execute", "blocked"]);
const primeRoot = process.env.PRIME_AGENT_ROOT;
if (!primeRoot) throw new Error("PRIME_AGENT_ROOT is required");
const { discoverAndLoadExtensions } = await import(pathToFileURL(join(primeRoot, "dist/core/extensions/loader.js")).href);
const cwd = mkdtempSync(join(tmpdir(), "prime-ralph-init-acceptance-"));
const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/prime-ralph.js", import.meta.url)), "init", "--project", cwd], { encoding: "utf8" });
if (cli.status !== 0) throw new Error(`initializer CLI failed: ${cli.stderr}`);
const createdCount = cli.stdout.split("created:").length - 1;
const loaded = await discoverAndLoadExtensions([], cwd, agentDir);
if (loaded.errors.length !== 0) throw new Error(`initialized extension load failed: ${JSON.stringify(loaded.errors)}`);
if (loaded.extensions.length !== 1) throw new Error(`expected one initialized extension, got ${loaded.extensions.length}`);
const extension = loaded.extensions[0];
const commandNames = [...extension.commands.keys()];
if (JSON.stringify(commandNames) !== JSON.stringify(["reset", "spec-it-out", "plan", "execute"]) || extension.commands.has("clear")) throw new Error("initialized extension command contract failed");
if (!extension.path.endsWith("/.prime/agent/extensions/prime-ralph/index.js")) throw new Error(`unexpected discovered path: ${extension.path}`);
if (existsSync(join(cwd, ".agents"))) throw new Error("clean initialization exposed internal Ralph prompts under .agents");

// Inspect the real Prime Agent command catalog, not only the loaded extension map.
writeFileSync(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# Acceptance fixture\n");
const rpc = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--mode", "rpc", "--offline", "--no-session", "--cwd", cwd], {
  input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n${JSON.stringify({ id: "abort", type: "abort" })}\n`,
  encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
});
if (rpc.error) throw rpc.error;
const rpcRecords = rpc.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const rpcCommands = rpcRecords.find((record) => record.id === "commands")?.data?.commands ?? [];
const ralphCatalog = rpcCommands.filter((command) => command.sourceInfo?.path?.startsWith(`${cwd}/`) &&
  (command.name === "reset" || CANONICAL_COMMAND_NAMES.has(command.name) || command.name.startsWith("skill:") && CANONICAL_COMMAND_NAMES.has(command.name.slice(6))));
const catalogSummary = ralphCatalog.map(({ name, source }) => ({ name, source }));
const expectedCatalog = [{ name: "reset", source: "extension" }, { name: "spec-it-out", source: "extension" }, { name: "plan", source: "extension" }, { name: "execute", source: "extension" }];
if (rpc.status !== 0 || JSON.stringify(catalogSummary) !== JSON.stringify(expectedCatalog)) {
  throw new Error(`native Ralph command catalog failed: status=${rpc.status} expected=${JSON.stringify(expectedCatalog)} actual=${JSON.stringify(catalogSummary)}`);
}

// Lock in the host-specific reason the initializer uses a directory symlink.
const bad = mkdtempSync(join(tmpdir(), "prime-ralph-init-bad-link-"));
const badAgent = join(bad, "agent"); mkdirSync(badAgent); mkdirSync(join(bad, ".prime/agent/extensions"), { recursive: true });
symlinkSync(new URL("../src/index.js", import.meta.url), join(bad, ".prime/agent/extensions/prime-ralph.js"), "file");
const rejected = await discoverAndLoadExtensions([], bad, badAgent);
if (!rejected.errors.length) throw new Error("direct file symlink unexpectedly loaded; relative module resolution contract changed");

let realBeadsStealth = "skipped (bd unavailable)";
if (spawnSync("bd", ["--version"], { encoding: "utf8" }).status === 0) {
  const repo = mkdtempSync(join(tmpdir(), "prime-ralph-init-beads-stealth-"));
  spawnSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "tracked"), "base\n");
  spawnSync("git", ["-C", repo, "add", "tracked"]);
  const commit = spawnSync("git", ["-C", repo, "-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-qm", "base"], { encoding: "utf8" });
  if (commit.status !== 0) throw new Error(`fixture commit failed: ${commit.stderr}`);
  spawnSync("git", ["-C", repo, "config", "--local", "beads.role", "viewer"]);
  const exclude = join(repo, ".git/info/exclude");
  writeFileSync(exclude, "preexisting\n"); writeFileSync(join(repo, ".gitignore"), "user-ignore\n");
  const before = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const beadsInit = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/prime-ralph.js", import.meta.url)), "init", "--project", repo, "--beads", "--stealth"], { encoding: "utf8" });
  if (beadsInit.status !== 0) throw new Error(`real Beads stealth initialization failed: ${beadsInit.stderr}`);
  const after = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const role = spawnSync("git", ["-C", repo, "config", "--local", "--get", "beads.role"], { encoding: "utf8" }).stdout.trim();
  const excludeText = readFileSync(exclude, "utf8");
  if (before !== after || role !== "viewer" || readFileSync(join(repo, ".gitignore"), "utf8") !== "user-ignore\n" || /RECOVERY|SESSION/.test(excludeText) || !excludeText.includes("/.beads/")) {
    throw new Error("real Beads stealth reconciliation contract failed");
  }
  realBeadsStealth = true;
}
console.log(JSON.stringify({ created: createdCount, warnings: cli.stderr ? 1 : 0, extensions: loaded.extensions.length, registeredCommands: commandNames, nativeRalphCatalog: catalogSummary, directFileSymlinkRejected: true, realBeadsStealth }, null, 2));
