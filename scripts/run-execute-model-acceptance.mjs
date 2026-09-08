import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.PRIME_RALPH_REAL_MODEL_ACCEPTANCE !== "1") { console.error("SKIP: set PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1"); process.exit(2); }
const provider = process.env.PRIME_RALPH_ACCEPT_PROVIDER, model = process.env.PRIME_RALPH_ACCEPT_MODEL;
if (!provider || !model) throw new Error("PRIME_RALPH_ACCEPT_PROVIDER and PRIME_RALPH_ACCEPT_MODEL are required");
const root = fileURLToPath(new URL("..", import.meta.url)), cwd = mkdtempSync(join(tmpdir(), "prime-ralph-execute-model-"));
const safeRegularFile = (path) => existsSync(path) && !lstatSync(path).isSymbolicLink() && lstatSync(path).isFile();
const safeDirectory = (path) => existsSync(path) && !lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory();
function treeDigest(directory, ignored = new Set()) {
  const hash = createHash("sha256");
  const visit = (current, prefix = "") => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name), relativePath = join(prefix, name);
      if (ignored.has(relativePath)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`unexpected symlink in acceptance source tree: ${relativePath}`);
      hash.update(relativePath);
      if (stat.isDirectory()) visit(path, relativePath); else hash.update(readFileSync(path));
    }
  };
  visit(directory); return hash.digest("hex");
}
function treeManifest(directory, current = directory, output = {}) {
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name), relativePath = relative(directory, path), stat = lstatSync(path);
    if (stat.isSymbolicLink()) output[relativePath] = { kind: "symlink" };
    else if (stat.isDirectory()) { output[relativePath] = { kind: "directory" }; treeManifest(directory, path, output); }
    else output[relativePath] = { kind: "file", sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
  }
  return output;
}
function changedManifestPaths(before, after) { return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => JSON.stringify(before[path]) !== JSON.stringify(after[path])); }
const sourceDigestBefore = treeDigest(join(root, "src"));
for (const dir of [".ralph/skills", ".ralph/plans/blocked", ".ralph/plans/archive", ".ralph/logs", ".prime/agent/extensions"]) mkdirSync(join(cwd, dir), { recursive: true });
for (const skill of ["prepare", "spec-it-out", "plan", "execute", "blocked"]) { mkdirSync(join(cwd, `.ralph/skills/${skill}`), { recursive: true }); cpSync(join(root, "templates/default", skill, "SKILL.md"), join(cwd, `.ralph/skills/${skill}/SKILL.md`)); }
cpSync(join(root, "src"), join(cwd, ".prime/agent/extensions/prime-ralph"), { recursive: true });
writeFileSync(join(cwd, ".prime/agent/extensions/prime-ralph/package.json"), '{"type":"module"}\n');
mkdirSync(join(cwd, ".prime/agent/extensions/prime-ralph/node_modules"));
for (const dependency of ["typebox", "yaml"]) cpSync(join(root, "node_modules", dependency), join(cwd, ".prime/agent/extensions/prime-ralph/node_modules", dependency), { recursive: true });
writeFileSync(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# Specification\n\nCreate `artifact.txt` containing exactly `slice-5-public-goal-path\\n`. Add `test.mjs` using node:test that verifies the exact content. Run the test. Do not use the network. Completion requires both files and a passing test.\n");
writeFileSync(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# Execution plan\n\n## Slice 1\n\nCreate the artifact and its exact-content test, run `node --test test.mjs`, then complete the Ralph lifecycle without archive.\n");
const skillsDigestBefore = treeDigest(join(cwd, ".ralph/skills")), extensionDigestBefore = treeDigest(join(cwd, ".prime/agent/extensions/prime-ralph"), new Set(["package.json"]));
const specificationBefore = readFileSync(join(cwd, ".ralph/plans/SPECIFICATION.md"), "utf8"), planBefore = readFileSync(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "utf8"), started = Date.now(), sessionDir = join(cwd, ".sessions"); mkdirSync(sessionDir);
const fixtureManifestBefore = treeManifest(cwd);
const common = ["--provider", provider, "--model", model, "--thinking", "off", "--offline", "--session-dir", sessionDir, "--tools", "ipython,ralph_lifecycle", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--cwd", cwd, "--system-prompt", "You are running controlled prime-ralph execution acceptance. Obey the injected prepare, planning, and execute skills. Use ipython with await bash(...) for filesystem work and tests. Use the public pre-imported goal module exactly as the execute skill directs. Complete the fixture only after explicit /execute; do not do unrelated work."];
const bootstrap = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--mode", "rpc", ...common], { input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n${JSON.stringify({ id: "abort", type: "abort" })}\n`, encoding: "utf8", timeout: 240_000, maxBuffer: 32 * 1024 * 1024, env: process.env });
if (bootstrap.error) throw bootstrap.error;
if (bootstrap.status !== 0 || bootstrap.signal) throw new Error(`controlled startup failed: status=${bootstrap.status} signal=${bootstrap.signal}`);
const bootstrapRecords = bootstrap.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const commandReply = bootstrapRecords.find((record) => record.id === "commands"), abortReply = bootstrapRecords.find((record) => record.id === "abort");
const commandCatalog = commandReply?.data?.commands ?? [], commandNames = commandCatalog.map((command) => command.name);
const copiedExtensionRoot = join(cwd, ".prime/agent/extensions/prime-ralph");
const copiedCommandSources = ["reset", "spec-it-out", "plan", "ralph-recover", "execute"].every((name) => commandCatalog.find((command) => command.name === name)?.sourceInfo?.path?.startsWith(copiedExtensionRoot));
const bootstrapFiles = safeDirectory(sessionDir) ? readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")) : [];
const bootstrapSessionPath = bootstrapFiles.length === 1 ? join(sessionDir, bootstrapFiles[0]) : null;
const bootstrapEntries = bootstrapSessionPath && safeRegularFile(bootstrapSessionPath) ? readFileSync(bootstrapSessionPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const bootstrapSessionId = bootstrapEntries[0]?.id;
const bootstrapReady = commandReply?.success === true && abortReply?.success === true && ["reset", "spec-it-out", "plan", "ralph-recover", "execute"].every((name) => commandNames.includes(name)) && copiedCommandSources &&
  typeof bootstrapSessionId === "string" && bootstrapEntries[0]?.type === "session" && bootstrapEntries[0]?.id === bootstrapSessionId &&
  bootstrapEntries.filter((entry) => entry.customType === "prime_ralph_planning_startup").length === 1 &&
  bootstrapEntries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").every((entry) => entry.message.stopReason === "aborted");
if (!bootstrapReady) throw new Error("controlled startup RPC did not establish one exact aborted planning boundary");
const settlementSessionFiles = [], settlementHeaderIds = [];
for (let index = 0; index < 2; index += 1) {
  const settlePrompt = `Discuss the existing execution plan without changing files, then wait for explicit /execute. ${"context ".repeat(15000)}`;
  const settle = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--mode", "json", ...common, "--continue", "--", settlePrompt], { encoding: "utf8", timeout: 240_000, maxBuffer: 32 * 1024 * 1024, env: process.env });
  if (settle.error) throw settle.error;
  if (settle.status !== 0 || settle.signal) throw new Error(`controlled startup settlement ${index + 1} failed: status=${settle.status} signal=${settle.signal}`);
  const settleRecords = settle.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const currentFiles = safeDirectory(sessionDir) ? readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")) : [];
  const currentSessionPath = currentFiles.length === 1 ? join(sessionDir, currentFiles[0]) : null;
  const currentHeader = currentSessionPath && safeRegularFile(currentSessionPath) ? JSON.parse(readFileSync(currentSessionPath, "utf8").split("\n")[0]) : null;
  if (!settleRecords.some((record) => record.type === "message_end" && record.message?.role === "assistant" && record.message.stopReason === "stop")) throw new Error(`controlled startup settlement ${index + 1} produced no normal assistant result`);
  settlementSessionFiles.push(currentFiles.length === 1 ? currentFiles[0] : null);
  settlementHeaderIds.push(currentHeader?.id);
}
const preExecutePlanPaths = [join(cwd, ".ralph/plans/SPECIFICATION.md"), join(cwd, ".ralph/plans/EXECUTION_PLAN.md")];
const preExecuteSurfacesSafe = preExecutePlanPaths.every(safeRegularFile) && safeDirectory(join(cwd, ".ralph/skills")) && safeDirectory(join(cwd, ".prime/agent/extensions/prime-ralph"));
const startupPreservedFixture = preExecuteSurfacesSafe && readFileSync(preExecutePlanPaths[0], "utf8") === specificationBefore && readFileSync(preExecutePlanPaths[1], "utf8") === planBefore && treeDigest(join(cwd, ".ralph/skills")) === skillsDigestBefore && treeDigest(join(cwd, ".prime/agent/extensions/prime-ralph"), new Set(["package.json"])) === extensionDigestBefore && !existsSync(join(cwd, "artifact.txt")) && !existsSync(join(cwd, "test.mjs")) && !existsSync(join(cwd, ".ralph/logs/EXECUTION_LOG.md"));
const run = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--mode", "json", ...common, "--continue", "--", "/execute"], { encoding: "utf8", timeout: 240_000, maxBuffer: 32 * 1024 * 1024, env: process.env });
if (run.error) throw run.error;
const records = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const sessionDirectorySafe = existsSync(sessionDir) && !lstatSync(sessionDir).isSymbolicLink() && lstatSync(sessionDir).isDirectory();
const finalSessionFiles = sessionDirectorySafe ? readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")) : [];
const finalSessionPath = finalSessionFiles.length === 1 ? join(sessionDir, finalSessionFiles[0]) : null;
const finalSessionSafe = finalSessionPath != null && !lstatSync(finalSessionPath).isSymbolicLink() && lstatSync(finalSessionPath).isFile();
const finalSessionText = finalSessionSafe ? readFileSync(finalSessionPath, "utf8") : "";
const finalHeader = finalSessionSafe ? JSON.parse(finalSessionText.split("\n")[0]) : null;
const sessionEntries = finalSessionSafe ? finalSessionText.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const messageText = (entry) => (entry?.message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const settlementUserIndexes = sessionEntries.map((entry, index) => messageText(entry).startsWith("Discuss the existing execution plan without changing files") ? index : -1).filter((index) => index >= 0);
const normalAssistantAfter = (index, before) => {
  const assistantsInRange = sessionEntries.map((entry, candidate) => ({ entry, candidate })).filter(({ entry, candidate }) => candidate > index && candidate < before && entry.type === "message" && entry.message?.role === "assistant");
  const terminal = assistantsInRange.at(-1);
  return terminal?.entry?.message?.stopReason === "stop" && terminal.entry.message.provider === provider && (terminal.entry.message.model === model || terminal.entry.message.responseModel === model) ? terminal.candidate : -1;
};
const startupIndexes = sessionEntries.map((entry, index) => entry.customType === "prime_ralph_planning_startup" ? index : -1).filter((index) => index >= 0);
const executeMarkerIndexes = sessionEntries.map((entry, index) => entry.customType === "prime_ralph_reset_marker" && entry.data?.command === "execute" ? index : -1).filter((index) => index >= 0);
const executeMarkerIndex = executeMarkerIndexes[0] ?? -1, executeRequestId = sessionEntries[executeMarkerIndex]?.data?.requestId;
const executeCompactionIndexes = sessionEntries.map((entry, index) => entry.type === "compaction" && entry.details?.requestId === executeRequestId ? index : -1).filter((index) => index >= 0);
const executeBoundaryIndexes = sessionEntries.map((entry, index) => entry.customType === "prime_ralph_reset_prepare" && entry.details?.requestId === executeRequestId ? index : -1).filter((index) => index >= 0);
const executeCompactionIndex = executeCompactionIndexes[0] ?? -1, executeBoundaryIndex = executeBoundaryIndexes[0] ?? -1;
const startupIndex = startupIndexes[0] ?? -1, abortedStartupIndex = sessionEntries.findIndex((entry, index) => index > startupIndex && entry.type === "message" && entry.message?.role === "assistant" && entry.message.stopReason === "aborted");
const settlementAssistantIndexes = settlementUserIndexes.map((index, position) => normalAssistantAfter(index, position + 1 < settlementUserIndexes.length ? settlementUserIndexes[position + 1] : executeMarkerIndex));
const executionAssistantIndex = sessionEntries.findIndex((entry, index) => index > executeBoundaryIndex && entry.type === "message" && entry.message?.role === "assistant" && entry.message.provider === provider);
const transcriptOrdering = startupIndexes.length === 1 && executeMarkerIndexes.length === 1 && executeCompactionIndexes.length === 1 && executeBoundaryIndexes.length === 1 && settlementUserIndexes.length === 2 && settlementAssistantIndexes.every((index) => index >= 0) && startupIndex >= 0 && startupIndex < abortedStartupIndex && abortedStartupIndex < settlementUserIndexes[0] && settlementUserIndexes[0] < settlementAssistantIndexes[0] && settlementAssistantIndexes[0] < settlementUserIndexes[1] && settlementUserIndexes[1] < settlementAssistantIndexes[1] && settlementAssistantIndexes[1] < executeMarkerIndex && executeMarkerIndex < executeCompactionIndex && executeCompactionIndex < executeBoundaryIndex && executeBoundaryIndex < executionAssistantIndex;
const goalStates = sessionEntries.filter((entry) => entry.customType === "thread_goal_state").map((entry) => entry.data), goalIds = new Set(goalStates.map((state) => state?.goalId).filter(Boolean));
const publicGoalTransition = goalIds.size === 1 && goalStates.some((state) => state?.status === "active" && state.active === true) && goalStates.at(-1)?.status === "complete" && goalStates.at(-1)?.active === false;
const assistants = records.filter((record) => record.type === "message_end" && record.message?.role === "assistant").map((record) => record.message);
const calls = assistants.flatMap((message) => (message.content ?? []).filter((part) => part.type === "toolCall"));
const ipythonCode = calls.filter((call) => call.name === "ipython").map((call) => String(call.arguments?.code ?? "")).join("\n");
const requiredOutputPaths = ["artifact.txt", "test.mjs", ".ralph/logs/EXECUTION_LOG.md", ".ralph/plans/SPECIFICATION.md", ".ralph/plans/EXECUTION_PLAN.md"];
const outputSurfaceSafe = finalSessionSafe && requiredOutputPaths.every((path) => safeRegularFile(join(cwd, path))) && [".ralph/plans/archive", ".ralph/plans/blocked", "session-artifacts"].every((path) => safeDirectory(join(cwd, path)));
const artifact = outputSurfaceSafe ? readFileSync(join(cwd, "artifact.txt"), "utf8") : null;
const planAfter = outputSurfaceSafe ? readFileSync(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "utf8") : null;
const planProgressRecorded = typeof planAfter === "string" && /behavior|work unit/i.test(planAfter) && /progress|result|completed/i.test(planAfter) && /evidence/i.test(planAfter) && /node --test test\.mjs[^]*pass/i.test(planAfter);
const testFile = outputSurfaceSafe ? readFileSync(join(cwd, "test.mjs"), "utf8") : null;
const log = outputSurfaceSafe ? readFileSync(join(cwd, ".ralph/logs/EXECUTION_LOG.md"), "utf8") : "";
const verificationDir = mkdtempSync(join(tmpdir(), "prime-ralph-test-verification-")), wrongArtifact = "wrong acceptance value\n";
let testVerification = { status: null, signal: null }, negativeTestVerification = { status: null, signal: null }, positiveTestIntegrity = false, negativeTestIntegrity = false;
if (artifact === "slice-5-public-goal-path\n" && typeof testFile === "string") {
  writeFileSync(join(verificationDir, "artifact.txt"), artifact, { flag: "wx" });
  writeFileSync(join(verificationDir, "test.mjs"), testFile, { flag: "wx" });
  const verificationArgs = ["--die-with-parent", "--unshare-net", "--ro-bind", "/", "/", "--bind", verificationDir, verificationDir, "--chdir", verificationDir, process.execPath, "--test", "test.mjs"];
  testVerification = spawnSync(process.env.BWRAP_BIN ?? "bwrap", verificationArgs, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, env: process.env });
  positiveTestIntegrity = safeRegularFile(join(verificationDir, "artifact.txt")) && safeRegularFile(join(verificationDir, "test.mjs")) && readFileSync(join(verificationDir, "artifact.txt"), "utf8") === artifact && readFileSync(join(verificationDir, "test.mjs"), "utf8") === testFile && JSON.stringify(Object.keys(treeManifest(verificationDir)).sort()) === JSON.stringify(["artifact.txt", "test.mjs"]);
  if (testVerification.status === 0 && !testVerification.signal && positiveTestIntegrity) {
    writeFileSync(join(verificationDir, "artifact.txt"), wrongArtifact);
    negativeTestVerification = spawnSync(process.env.BWRAP_BIN ?? "bwrap", verificationArgs, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, env: process.env });
    negativeTestIntegrity = safeRegularFile(join(verificationDir, "artifact.txt")) && safeRegularFile(join(verificationDir, "test.mjs")) && readFileSync(join(verificationDir, "artifact.txt"), "utf8") === wrongArtifact && readFileSync(join(verificationDir, "test.mjs"), "utf8") === testFile && JSON.stringify(Object.keys(treeManifest(verificationDir)).sort()) === JSON.stringify(["artifact.txt", "test.mjs"]);
  }
}
rmSync(verificationDir, { recursive: true, force: true });
const sourceTreesUnchanged = treeDigest(join(root, "src")) === sourceDigestBefore && treeDigest(join(cwd, ".prime/agent/extensions/prime-ralph"), new Set(["package.json"])) === extensionDigestBefore && treeDigest(join(cwd, ".ralph/skills")) === skillsDigestBefore;
const fixtureManifestAfter = treeManifest(cwd), fixtureChanges = changedManifestPaths(fixtureManifestBefore, fixtureManifestAfter);
const kernelArtifactRoot = join(cwd, "session-artifacts"), kernelArtifactDirectories = outputSurfaceSafe ? readdirSync(kernelArtifactRoot, { withFileTypes: true }) : [];
const kernelArtifactDirectory = kernelArtifactDirectories.length === 1 && kernelArtifactDirectories[0].isDirectory() ? kernelArtifactDirectories[0].name : null;
const kernelArtifactNames = kernelArtifactDirectory ? readdirSync(join(kernelArtifactRoot, kernelArtifactDirectory)).sort() : [];
const expectedKernelArtifactNames = ["kernel-state.dill", "kernel-state.json", "kernel-stderr.log", "semantic-edges.jsonl"];
const kernelArtifactsExact = typeof kernelArtifactDirectory === "string" && JSON.stringify(kernelArtifactNames) === JSON.stringify(expectedKernelArtifactNames);
const kernelStderrEmpty = kernelArtifactsExact && readFileSync(join(kernelArtifactRoot, kernelArtifactDirectory, "kernel-stderr.log")).length === 0;
const semanticEdgeLines = kernelArtifactsExact ? readFileSync(join(kernelArtifactRoot, kernelArtifactDirectory, "semantic-edges.jsonl"), "utf8").split("\n").filter(Boolean) : [];
const semanticEdgesStructured = semanticEdgeLines.length > 0 && semanticEdgeLines.every((line) => typeof JSON.parse(line)?.type === "string");
const allowedKernelPaths = new Set(kernelArtifactDirectory ? ["session-artifacts", `session-artifacts/${kernelArtifactDirectory}`, ...kernelArtifactNames.map((name) => `session-artifacts/${kernelArtifactDirectory}/${name}`)] : []);
const allowedFixtureChange = (path) => ["artifact.txt", "test.mjs", ".ralph/logs/EXECUTION_LOG.md", ".ralph/plans/EXECUTION_PLAN.md", `.sessions/${bootstrapFiles[0]}`].includes(path) || allowedKernelPaths.has(path);
const expectedRegularFiles = ["artifact.txt", "test.mjs", ".ralph/logs/EXECUTION_LOG.md", ".ralph/plans/EXECUTION_PLAN.md", `.sessions/${bootstrapFiles[0]}`, ...kernelArtifactNames.map((name) => `session-artifacts/${kernelArtifactDirectory}/${name}`)];
const expectedDirectories = ["session-artifacts", `session-artifacts/${kernelArtifactDirectory}`];
const fixtureKindsExact = expectedRegularFiles.every((path) => fixtureManifestAfter[path]?.kind === "file") && expectedDirectories.every((path) => fixtureManifestAfter[path]?.kind === "directory");
const fixtureMutationScopeExact = outputSurfaceSafe && kernelArtifactsExact && kernelStderrEmpty && semanticEdgesStructured && fixtureKindsExact && fixtureChanges.every(allowedFixtureChange) && [...expectedRegularFiles, ...expectedDirectories].every((path) => fixtureChanges.includes(path));
const checks = {
  processSucceeded: run.status === 0 && !run.signal,
  bootstrapReady,
  sameIsolatedSession: settlementHeaderIds.every((id) => id === bootstrapSessionId) && settlementSessionFiles.every((name) => name === bootstrapFiles[0]) && finalHeader?.id === bootstrapSessionId && finalSessionFiles.length === 1 && finalSessionFiles[0] === bootstrapFiles[0],
  startupPreservedFixture,
  sourceTreesUnchanged,
  kernelArtifactsExact,
  kernelStderrEmpty,
  semanticEdgesStructured,
  fixtureMutationScopeExact,
  transcriptOrdering,
  artifactExact: artifact === "slice-5-public-goal-path\n",
  testCreated: typeof testFile === "string" && /node:test/.test(testFile) && /artifact\.txt/.test(testFile) && /slice-5-public-goal-path/.test(testFile),
  independentlyPassingTest: testVerification.status === 0 && !testVerification.signal && positiveTestIntegrity && typeof negativeTestVerification.status === "number" && negativeTestVerification.status !== 0 && !negativeTestVerification.signal && negativeTestIntegrity,
  publicGoalCreateObserved: publicGoalTransition && /goal\.create\s*\(/.test(ipythonCode),
  publicGoalCompleteObserved: publicGoalTransition && /goal\.complete\s*\(/.test(ipythonCode),
  lifecycleCompleteObserved: calls.some((call) => call.name === "ralph_lifecycle" && call.arguments?.action === "complete"),
  completedPassLogged: /phase=execute/.test(log) && /artifact|test|slice-5/i.test(log),
  noArchive: outputSurfaceSafe && existsSync(join(cwd, ".ralph/plans/SPECIFICATION.md")) && existsSync(join(cwd, ".ralph/plans/EXECUTION_PLAN.md")) && readFileSync(join(cwd, ".ralph/plans/SPECIFICATION.md"), "utf8") === specificationBefore && readdirSync(join(cwd, ".ralph/plans/archive")).length === 0 && readdirSync(join(cwd, ".ralph/plans/blocked")).length === 0 && planProgressRecorded,
  providerObserved: assistants.some((message) => message.provider === provider),
  modelObserved: assistants.some((message) => message.model === model || message.responseModel === model),
};
const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
const result = { schemaVersion: 1, evidenceKind: "real-model-public-goal-execution", generatedAt: new Date().toISOString(), provider, model, durationMs: Date.now() - started, cwd, checks, observed: { status: run.status, signal: run.signal, toolCalls: calls.map((call) => call.name), kernelArtifactNames, finalAssistantTextOmitted: true } };
const artifactDir = resolve(process.argv.includes("--artifact-dir") ? process.argv[process.argv.indexOf("--artifact-dir") + 1] : join(root, "docs/acceptance")); mkdirSync(artifactDir, { recursive: true });
const serialized = JSON.stringify(result, null, 2) + "\n"; if (/\b(?:sk|pk)[-_][A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|Bearer\s+[A-Za-z0-9._~+\/-]{16,}/i.test(serialized)) throw new Error("secret-shaped output rejected");
writeFileSync(join(artifactDir, "execute-model-acceptance.json"), serialized);
console.log(JSON.stringify({ artifactPath: join(artifactDir, "execute-model-acceptance.json"), checks, failures }, null, 2));
if (failures.length) process.exit(1);
