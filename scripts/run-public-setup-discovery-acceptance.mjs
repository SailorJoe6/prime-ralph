import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_COMMANDS = ["reset", "spec-it-out", "plan", "ralph-recover", "execute"];
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const initBin = fileURLToPath(new URL("../bin/prime-ralph.js", import.meta.url));
const primeAgentBin = process.env.PRIME_AGENT_BIN ?? "prime-agent";
const primeAgentVersion = readPrimeAgentVersion();
const temp = mkdtempSync(join(tmpdir(), "prime-ralph-public-setup-discovery-"));

try {
  const sourceProject = join(temp, "source-project");
  mkdirSync(sourceProject);
  runInit(process.execPath, [initBin, "init", "--project", sourceProject], "source initializer");
  const sourceCatalog = readPublicCatalog(sourceProject, sourceRoot, "source initialization");

  const packRoot = join(temp, "pack");
  mkdirSync(packRoot);
  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", packRoot], {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (pack.error) throw pack.error;
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const packed = JSON.parse(pack.stdout)[0];
  const tarball = join(packRoot, packed.filename);
  const installRoot = join(temp, "install");
  mkdirSync(installRoot);
  const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=peer", "--prefix", installRoot, tarball], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error(`packed install failed: ${install.stderr}`);

  const installedRoot = join(installRoot, "node_modules/prime-ralph");
  const installedCli = join(installRoot, "node_modules/.bin/prime-ralph");
  const installedProject = join(temp, "installed-project");
  mkdirSync(installedProject);
  runInit(installedCli, ["init", "--project", installedProject], "installed initializer");
  const installedCatalog = readPublicCatalog(installedProject, installedRoot, "packed installation");

  console.log(JSON.stringify({
    schemaVersion: 1,
    evidenceKind: "public-spawned-setup-discovery",
    primeAgentVersion,
    checks: {
      supportedSpawnedRpc: true,
      sourceInitializerDiscovered: true,
      sourceCommandCatalogExact: true,
      packedInitializerDiscovered: true,
      packedCommandCatalogExact: true,
      packedExtensionTargetBound: true,
      extensionLoadErrorsAbsent: true,
      abortAcknowledged: true,
      noProviderBehaviorClaimed: true,
    },
    observed: {
      sourceCatalog,
      installedCatalog,
    },
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function runInit(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr}`);
}

function readPublicCatalog(project, expectedTargetRoot, label) {
  const request = [
    { id: "commands", type: "get_commands" },
    { id: "abort", type: "abort" },
  ].map(JSON.stringify).join("\n") + "\n";
  const result = spawnSync(primeAgentBin, [
    "--mode", "rpc",
    "--offline",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--cwd", project,
  ], {
    input: request,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} public RPC failed: status=${result.status} stderr=${result.stderr}`);
  const records = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const extensionError = records.find((record) => record.type === "extension_error" || record.type === "extension_load_error");
  if (extensionError || /extension.{0,40}(?:error|failed)/i.test(result.stderr)) {
    throw new Error(`${label} reported an extension load error: ${JSON.stringify(extensionError) || result.stderr}`);
  }
  const response = records.find((record) => record.id === "commands" && record.type === "response");
  if (response?.success !== true) throw new Error(`${label} get_commands failed: ${JSON.stringify(response)}`);
  const abort = records.find((record) => record.id === "abort" && record.type === "response");
  if (abort?.command !== "abort" || abort.success !== true) throw new Error(`${label} abort was not acknowledged: ${JSON.stringify(abort)}`);
  const commands = response.data?.commands ?? [];
  const expectedEntry = join(project, ".prime/agent/extensions/prime-ralph/index.js");
  const projectCommands = commands.filter((command) => command.sourceInfo?.path === expectedEntry);
  if (JSON.stringify(projectCommands.map((command) => command.name)) !== JSON.stringify(EXPECTED_COMMANDS)) {
    throw new Error(`${label} project command catalog mismatch: ${JSON.stringify(commands)}`);
  }
  for (const command of projectCommands) {
    if (command.source !== "extension" || command.sourceInfo?.path !== expectedEntry || command.sourceInfo?.source !== "auto" || command.sourceInfo?.scope !== "project" || command.sourceInfo?.origin !== "top-level") {
      throw new Error(`${label} exposed an unexpected public command source: ${JSON.stringify(command)}`);
    }
  }
  const resolvedEntry = realpathSync(expectedEntry);
  const resolvedRoot = realpathSync(expectedTargetRoot);
  if (resolvedEntry !== join(resolvedRoot, "src/index.js")) {
    throw new Error(`${label} extension target mismatch: expected=${join(resolvedRoot, "src/index.js")} actual=${resolvedEntry}`);
  }
  return projectCommands.map(({ name, source }) => ({ name, source }));
}

function readPrimeAgentVersion() {
  const result = spawnSync(primeAgentBin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`prime-agent --version failed: ${result.stderr}`);
  const version = `${result.stdout}${result.stderr}`.trim();
  if (version !== "0.9.3") throw new Error(`unsupported Prime Agent version: ${version}`);
  return version;
}
