import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizedPrimeAgentEnvironment } from "./public-acceptance-env.mjs";

const PRIME_AGENT_VERSION = "0.9.3";
const PROVIDER = "ralph-public-reset";
const MODEL = "reset-fixture";
const PREPARE_SENTINEL = "PUBLIC_RESET_PREPARE_51ad";
const STALE_SENTINEL = "PUBLIC_RESET_STALE_830e";
const COMPACTION_SUMMARY = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n\n</summary>";
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const initBin = fileURLToPath(new URL("../bin/prime-ralph.js", import.meta.url));
const primeAgentBin = process.env.PRIME_AGENT_BIN ?? "prime-agent";
const childEnv = sanitizedPrimeAgentEnvironment();
const temp = mkdtempSync(join(tmpdir(), "prime-ralph-public-reset-"));
let rpcChild;
let rpcController;
let server;

try {
  const version = runPrimeAgent(["--version"], "version").trim();
  if (version !== PRIME_AGENT_VERSION) throw new Error(`unsupported Prime Agent version: ${version}`);
  const daemonBefore = readDefaultDaemonIdentity();

  const project = join(temp, "project");
  const sessionDir = join(temp, "sessions");
  const providerDir = join(temp, "provider");
  mkdirSync(project);
  mkdirSync(sessionDir);
  mkdirSync(providerDir);
  runInit(project);
  const extensionEntry = join(project, ".prime/agent/extensions/prime-ralph/index.js");
  if (realpathSync(extensionEntry) !== join(realpathSync(sourceRoot), "src/index.js")) {
    throw new Error("initialized extension does not target the tested source tree");
  }
  writeFileSync(join(project, ".ralph/skills/prepare/SKILL.md"), `---\nname: prepare\ndescription: Public reset acceptance fixture\n---\n\n${PREPARE_SENTINEL}\n`);
  writeFileSync(join(project, ".prime/agent/settings.json"), `${JSON.stringify({ autoRefine: { enabled: false } }, null, 2)}\n`);

  const providerBodies = [];
  const providerObservations = [];
  let sessionFileForCapture;
  let providerError;
  let rpc;
  server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const requestObservedAt = process.hrtime.bigint();
    const jsonlAtRequest = sessionFileForCapture ? readFileSync(sessionFileForCapture, "utf8") : undefined;
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      providerBodies.push(body);
      providerObservations.push({ body, requestObservedAt, jsonlAtRequest });
      const index = providerBodies.length - 1;
      const id = `chatcmpl-public-reset-${index}`;
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [{ index: 0, delta: { role: "assistant", content: `fixture response ${index}` }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    })().catch((error) => {
      providerError = error instanceof Error ? error : new Error(String(error));
      rpc?.fail(providerError);
      response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new Error("scripted provider is not loopback-bound");
  const providerEntry = join(providerDir, "index.js");
  writeFileSync(providerEntry, providerExtension(address.port));

  rpc = startRpc({ project, sessionDir, extensionEntry, providerEntry });
  rpcController = rpc;
  rpcChild = rpc.child;
  let state = await rpc.waitForIdle({ minimumProviderCalls: 1, providerBodies });
  sessionFileForCapture = state.sessionFile;
  const autoCompaction = await rpc.command("set_auto_compaction", { enabled: false });
  if (autoCompaction.success !== true || autoCompaction.command !== "set_auto_compaction") throw new Error("public RPC could not disable automatic compaction");
  const startupSystem = providerBodies[0]?.messages?.find((message) => message.role === "system")?.content;
  if (typeof startupSystem !== "string" || !startupSystem) throw new Error("startup provider input lacked the host system prompt");

  for (let index = 0; index < 4; index += 1) {
    const minimumProviderCalls = providerBodies.length + 1;
    const prompt = await rpc.command("prompt", { message: `PUBLIC_RESET_HISTORY_${index}_${STALE_SENTINEL} ${"old context ".repeat(2500)}` });
    if (prompt.success !== true || prompt.command !== "prompt") throw new Error(`history prompt was not accepted: ${JSON.stringify(prompt)}`);
    state = await rpc.waitForIdle({ minimumProviderCalls, providerBodies });
  }

  const identityBefore = { sessionId: state.sessionId, sessionFile: state.sessionFile };
  if (!identityBefore.sessionFile) throw new Error("public RPC did not expose a durable session file");
  const jsonlBefore = readFileSync(identityBefore.sessionFile, "utf8");
  if (!jsonlBefore.includes(STALE_SENTINEL)) throw new Error("pre-reset durable history lacks the sentinel");
  const providerCallsBeforeReset = providerBodies.length;
  const resetResponse = await rpc.command("prompt", { message: "/reset" });
  if (resetResponse.success !== true || resetResponse.command !== "prompt") throw new Error(`reset command was not accepted: ${JSON.stringify(resetResponse)}`);
  state = await rpc.waitForIdle({ minimumProviderCalls: providerCallsBeforeReset + 1, providerBodies });
  const messagesResponse = await rpc.command("get_messages");
  if (messagesResponse.success !== true || messagesResponse.command !== "get_messages") throw new Error("public RPC get_messages failed after reset");

  if (providerError) throw providerError;
  const jsonlAfter = readFileSync(state.sessionFile, "utf8");
  const entries = jsonlAfter.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const resetObservation = providerObservations[providerCallsBeforeReset];
  const resetSnapshot = resetObservation?.jsonlAtRequest;
  const snapshotEntries = resetSnapshot?.split("\n").filter(Boolean).map((line) => JSON.parse(line)) ?? [];
  const resetMarkers = entries.filter((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_marker" && entry.data?.command === "reset");
  const resetCompactions = entries.filter((entry) => entry.type === "compaction" && entry.customInstructions?.startsWith("prime-ralph-reset:v3:"));
  const resetMessages = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare" && entry.details?.command === "reset");
  const completedStates = entries.filter((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_state" && entry.data?.status === "completed" && entry.data?.command === "reset");
  const resetMarker = resetMarkers.at(-1);
  const resetCompaction = resetCompactions.at(-1);
  const resetMessage = resetMessages.at(-1);
  const completedState = completedStates.at(-1);
  const resetRequestId = resetMessage?.details?.requestId;
  const resetInstruction = typeof resetRequestId === "string" ? `prime-ralph-reset:v3:${resetRequestId}` : undefined;
  const markerIndex = entries.indexOf(resetMarker);
  const compactionIndex = entries.indexOf(resetCompaction);
  const messageIndex = entries.indexOf(resetMessage);
  const completedIndex = entries.indexOf(completedState);

  const snapshotMarker = snapshotEntries.find((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_marker" && entry.data?.requestId === resetRequestId);
  const snapshotCompaction = snapshotEntries.find((entry) => entry.type === "compaction" && entry.customInstructions === resetInstruction && entry.details?.requestId === resetRequestId);
  const snapshotMessage = snapshotEntries.find((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare" && entry.details?.requestId === resetRequestId);
  const snapshotMarkerIndex = snapshotEntries.indexOf(snapshotMarker);
  const snapshotCompactionIndex = snapshotEntries.indexOf(snapshotCompaction);
  const snapshotMessageIndex = snapshotEntries.indexOf(snapshotMessage);

  const resetProviderBodies = providerBodies.slice(providerCallsBeforeReset);
  const compactionStarts = rpc.records.filter((record) => record.type === "compaction_start" && record.customInstructions === resetInstruction);
  const compactionEnds = rpc.records.filter((record) => record.type === "compaction_end" && record.customInstructions === resetInstruction && record.result?.details?.requestId === resetRequestId);
  const compactionEndObservation = rpc.recordObservations.find(({ record }) => record === compactionEnds[0]);
  const providerBody = resetProviderBodies[0];
  const providerMessages = providerBody?.messages;
  const expectedProviderMessages = [
    { role: "system", content: startupSystem },
    { role: "user", content: [{ type: "text", text: COMPACTION_SUMMARY }] },
    { role: "user", content: [{ type: "text", text: resetMessage?.content }] },
  ];
  const publicMessages = messagesResponse.data?.messages ?? [];
  const resetEvent = rpc.records.find((record) => record.type === "message_start" && record.message?.customType === "prime_ralph_reset_prepare" && record.message?.details?.requestId === resetRequestId);
  const resetNotice = rpc.records.find((record) => record.type === "extension_ui_request" && record.method === "notify" && record.message === "Ralph reset started." && record.notifyType === "info");
  const transactionIds = [
    resetMarker?.data?.requestId,
    resetCompaction?.details?.requestId,
    resetCompaction?.customInstructions?.split(":").at(-1),
    resetMessage?.details?.requestId,
    completedState?.data?.requestId,
  ];
  const transactionSessionIds = [
    resetMarker?.data?.sessionId,
    resetCompaction?.details?.sessionId,
    resetMessage?.details?.sessionId,
    completedState?.data?.sessionId,
  ];

  const checks = {
    supportedSpawnedRpc: true,
    childEnvironmentSanitized: Object.keys(childEnv).every((key) => !key.startsWith("PRIME_AGENT_INTERNAL_")) && !Object.hasOwn(childEnv, "PRIME_AGENT_KERNEL_OWNER_PID") && !Object.hasOwn(childEnv, "RLM_DEPTH"),
    loopbackScriptedProvider: address.address === "127.0.0.1",
    resetCommandAcknowledged: resetResponse.success === true,
    automaticCompactionDisabled: autoCompaction.success === true,
    oneResetProviderRequest: resetProviderBodies.length === 1,
    oneResetMarker: resetMarkers.length === 1,
    oneResetCompaction: resetCompactions.length === 1,
    oneResetBoundary: resetMessages.length === 1,
    oneCompletedReset: completedStates.length === 1,
    requestIdentityBound: typeof resetRequestId === "string" && transactionIds.every((id) => id === resetRequestId) && transactionSessionIds.every((id) => id === identityBefore.sessionId),
    durableOrdering: markerIndex >= 0 && markerIndex < compactionIndex && compactionIndex < messageIndex && messageIndex < completedIndex,
    markerAnchoredCompaction: typeof resetMarker?.id === "string" && resetCompaction?.firstKeptEntryId === resetMarker.id,
    compactionEventsExact: compactionStarts.length === 1 && compactionEnds.length === 1 && compactionEnds[0].aborted === false && compactionEnds[0].result?.firstKeptEntryId === resetMarker?.id,
    publicCompactionSettledBeforeProvider: typeof compactionEndObservation?.observedAt === "bigint" && typeof resetObservation?.requestObservedAt === "bigint" && compactionEndObservation.observedAt < resetObservation.requestObservedAt,
    boundaryDurableBeforeProvider: typeof resetSnapshot === "string" && resetSnapshot.startsWith(jsonlBefore) && snapshotMarkerIndex >= 0 && snapshotMarkerIndex < snapshotCompactionIndex && snapshotCompactionIndex < snapshotMessageIndex && snapshotCompaction?.firstKeptEntryId === snapshotMarker?.id,
    providerTranscriptEquivalent: JSON.stringify(providerMessages) === JSON.stringify(expectedProviderMessages),
    systemPromptPreserved: providerMessages?.filter((message) => message.role === "system").length === 1 && providerMessages[0]?.content === startupSystem,
    prepareExactlyOnce: JSON.stringify(providerBody).split(PREPARE_SENTINEL).length - 1 === 1,
    staleProviderContextExcluded: !JSON.stringify(providerBody).includes(STALE_SENTINEL),
    sameSessionIdentity: state.sessionId === identityBefore.sessionId && state.sessionFile === identityBefore.sessionFile,
    appendOnlyJsonl: jsonlAfter.startsWith(jsonlBefore) && jsonlAfter.length > jsonlBefore.length,
    durableHistoryRetained: jsonlAfter.includes(STALE_SENTINEL),
    publicMessagesMatchDurableBoundary: publicMessages.length === 3 && publicMessages[0]?.role === "compactionSummary" && publicMessages[0]?.summary === "" && publicMessages[1]?.customType === "prime_ralph_reset_prepare" && publicMessages[1]?.content === resetMessage?.content && publicMessages[2]?.role === "assistant",
    publicResetEventObserved: Boolean(resetEvent),
    publicResetNoticeObserved: Boolean(resetNotice),
    noPendingSessionAction: state.sessionActions?.queuedCount === 0 && state.sessionActions?.steering?.length === 0 && state.sessionActions?.followUps?.length === 0,
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);

  await rpc.stop();
  rpcController = undefined;
  rpcChild = undefined;
  const daemonAfter = readDefaultDaemonIdentity();
  checks.defaultDaemonIdentityStable = JSON.stringify(daemonBefore) === JSON.stringify(daemonAfter);
  if (!checks.defaultDaemonIdentityStable) failures.push("defaultDaemonIdentityStable");
  if (failures.length) throw new Error(JSON.stringify({ checks, failures }, null, 2));

  console.log(JSON.stringify({
    schemaVersion: 1,
    evidenceKind: "public-spawned-reset-compaction",
    primeAgentVersion: version,
    checks,
    observed: {
      providerCalls: providerBodies.length,
      resetRequestId,
      resetMode: resetMessage.details.mode,
      resetWorkflowPhase: resetMessage.details.workflowPhase,
      publicMessageRoles: publicMessages.map((message) => message.role),
      defaultDaemonPresent: daemonAfter.present,
      ...(daemonAfter.present ? { defaultDaemonPid: daemonAfter.pid } : {}),
    },
  }, null, 2));
} finally {
  if (rpcController) await rpcController.stop().catch(() => {});
  else if (rpcChild && rpcChild.exitCode === null) rpcChild.kill("SIGTERM");
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}

function providerExtension(port) {
  return `export default function (pi) {\n  pi.registerProvider(${JSON.stringify(PROVIDER)}, {\n    baseUrl: ${JSON.stringify(`http://127.0.0.1:${port}/v1`)},\n    apiKey: "fixture",\n    api: "openai-completions",\n    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },\n    models: [{ id: ${JSON.stringify(MODEL)}, name: "Reset Fixture", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],\n  });\n}\n`;
}

function runInit(project) {
  const result = spawnSync(process.execPath, [initBin, "init", "--project", project], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: childEnv });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`source initializer failed with status ${result.status}`);
}

function runPrimeAgent(args, label) {
  const result = spawnSync(primeAgentBin, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: childEnv });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Prime Agent ${label} failed with status ${result.status}`);
  return result.stdout || result.stderr;
}

function readDefaultDaemonIdentity() {
  const rows = JSON.parse(runPrimeAgent(["status", "--json"], "status"));
  if (!Array.isArray(rows)) throw new Error("default daemon status is not an array");
  const current = rows.filter((row) => row.isDefault === true && row.status === "current");
  if (current.length === 0) return { present: false };
  if (current.length !== 1 || !Number.isInteger(current[0].pid) || typeof current[0].socketPath !== "string") {
    throw new Error("default daemon status is ambiguous or invalid");
  }
  return { present: true, pid: current[0].pid, socketPath: current[0].socketPath };
}

function startRpc({ project, sessionDir, extensionEntry, providerEntry }) {
  const child = spawn(primeAgentBin, [
    "--mode", "rpc",
    "--offline",
    "--provider", PROVIDER,
    "--model", MODEL,
    "--thinking", "off",
    "--session-dir", sessionDir,
    "--no-extensions",
    "--extension", extensionEntry,
    "--extension", providerEntry,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-tools",
    "--cwd", project,
  ], { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
  const records = [];
  const recordObservations = [];
  const waiters = new Map();
  let fatalError;
  let stderrBytes = 0;
  let sequence = 0;
  let stdoutBuffer = "";

  const rejectWaiters = (error) => {
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };
  const fail = (error) => {
    if (fatalError) return;
    fatalError = error instanceof Error ? error : new Error(String(error));
    rejectWaiters(fatalError);
  };
  const acceptRecord = (line) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail(new Error("public RPC emitted an invalid LF-delimited JSON record"));
      return;
    }
    records.push(record);
    recordObservations.push({ record, observedAt: process.hrtime.bigint() });
    const waiter = record.id ? waiters.get(record.id) : undefined;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(record.id);
      waiter.resolve(record);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (fatalError) return;
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length === 0) {
        fail(new Error("public RPC emitted an empty JSONL record"));
        return;
      }
      acceptRecord(line);
      if (fatalError) return;
    }
  });
  child.stdout.on("end", () => {
    if (stdoutBuffer.length !== 0) fail(new Error("public RPC ended with an unterminated JSONL record"));
  });
  child.stderr.on("data", (chunk) => { stderrBytes += Buffer.byteLength(chunk); });

  const exit = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      fail(new Error(`public RPC process error: ${error.code ?? "unknown"}`));
      reject(fatalError);
    });
    child.once("close", (code, signal) => {
      if (fatalError) reject(fatalError);
      else if (code === 0) resolve();
      else {
        const error = new Error(`public RPC exited code=${code} signal=${signal} stderrBytes=${stderrBytes}`);
        fail(error);
        reject(error);
      }
    });
  });
  void exit.catch(() => {});

  const command = (type, details = {}) => new Promise((resolve, reject) => {
    if (fatalError) {
      reject(fatalError);
      return;
    }
    if (child.exitCode !== null || child.stdin.destroyed) {
      reject(new Error(`public RPC is unavailable for ${type}`));
      return;
    }
    const id = `rpc-${sequence++}`;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`timed out waiting for public RPC ${type}`));
    }, 30_000);
    waiters.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, type, ...details })}\n`, (error) => {
      if (!error) return;
      const waiter = waiters.get(id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiters.delete(id);
      waiter.reject(new Error(`failed to write public RPC ${type}`));
    });
  });
  const waitForIdle = async ({ minimumProviderCalls, providerBodies }) => {
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (fatalError) throw fatalError;
      const response = await command("get_state");
      if (response.success === true && providerBodies.length >= minimumProviderCalls && !response.data.isStreaming && !response.data.isCompacting && response.data.sessionActions?.queuedCount === 0) return response.data;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for public RPC settlement");
  };
  const stop = async () => {
    if (child.exitCode === null && !child.stdin.destroyed) child.stdin.end();
    let outcome = await settleWithin(exit, 2_000);
    if (!outcome.settled && child.exitCode === null) {
      child.kill("SIGTERM");
      outcome = await settleWithin(exit, 2_000);
    }
    if (!outcome.settled && child.exitCode === null) {
      child.kill("SIGKILL");
      outcome = await settleWithin(exit, 2_000);
    }
    if (!outcome.settled) throw new Error("public RPC did not terminate within the bounded cleanup interval");
    if (outcome.error) throw outcome.error;
  };
  return { child, command, exit, fail, recordObservations, records, stop, waitForIdle };
}

async function settleWithin(promise, milliseconds) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: false }), milliseconds); });
  const settled = promise.then(
    () => ({ settled: true }),
    (error) => ({ settled: true, error }),
  );
  const outcome = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return outcome;
}
