import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXECUTION_STATE_ENTRY_TYPE } from "../src/execution.js";
import { RECOVERY_STATE_TYPE, planRalphRecovery } from "../src/recovery.js";
import { RESET_MARKER_TYPE, RESET_MESSAGE_TYPE, RESET_PROTOCOL_VERSION, RESET_STATE_TYPE, resetCompactionInstructions } from "../src/reset-context.js";

const primeRoot = process.env.PRIME_AGENT_ROOT, coreRoot = process.env.PRIME_AGENT_CORE_ROOT;
if (!primeRoot || !coreRoot) throw new Error("PRIME_AGENT_ROOT and PRIME_AGENT_CORE_ROOT are required");
const imp = (path) => import(pathToFileURL(join(primeRoot, "dist", path)).href);
const [{ Agent }, { AgentSession }, { SessionManager }, { SettingsManager }, { AuthStorage }, { ModelRegistry }, { DefaultResourceLoader }, { convertToLlm }, { createIpythonTool, IpythonKernelProvisioner }] = await Promise.all([
  import(pathToFileURL(join(coreRoot, "dist/agent.js")).href), imp("core/agent-session.js"), imp("core/session-manager.js"), imp("core/settings-manager.js"), imp("core/auth-storage.js"), imp("core/model-registry.js"), imp("core/resource-loader.js"), imp("core/messages.js"), imp("core/tools/index.js"),
]);
const model = { provider: "acceptance", id: "forbidden", api: "openai-completions", contextWindow: 120000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const waitFor = async (predicate, label) => { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`); await new Promise((resolve) => setTimeout(resolve, 10)); } };

async function fixture({ cancel = false, legacy = false, postCompacted = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), `prime-ralph-recovery-${cancel ? "cancel" : "success"}-`)), sessionDir = join(cwd, "sessions"), agentDir = join(cwd, ".agent");
  for (const dir of [".ralph/skills/prepare", ".ralph/skills/spec-it-out", ".ralph/skills/plan", ".ralph/skills/execute", ".ralph/skills/blocked", ".ralph/plans/blocked", ".ralph/plans/archive", ".prime/agent/extensions", "sessions", ".agent"]) await mkdir(join(cwd, dir), { recursive: true });
  await symlink(new URL("../src", import.meta.url), join(cwd, ".prime/agent/extensions/prime-ralph"), "dir");
  for (const [name, body] of Object.entries({ prepare: "RECOVERY_PREPARE", "spec-it-out": "spec", plan: "plan", execute: "execute", blocked: "blocked" })) await writeFile(join(cwd, `.ralph/skills/${name}/SKILL.md`), `---
name: ${name}
description: acceptance
${name === "prepare" ? "" : "prime-ralph-invocation-version: 1\n"}---
${body}
`);
  const specPath = join(cwd, ".ralph/plans/SPECIFICATION.md"), planPath = join(cwd, ".ralph/plans/EXECUTION_PLAN.md");
  await writeFile(specPath, "# recovery specification\n"); await writeFile(planPath, "# recovery plan\n");
  const mutationPath = join(cwd, "durable-external-mutation.txt"); await writeFile(mutationPath, "filesystem and issue-state sentinel\n");
  const cancelPath = join(cwd, "cancel-tree.mjs");
  if (cancel) await writeFile(cancelPath, `export default function (pi) { pi.on("session_before_tree", () => ({ cancel: true })); }\n`);
  const sm = SessionManager.create(cwd, sessionDir), sessionId = sm.getSessionId(), requestId = "poison-request", lifecycleId = "poison-lifecycle";
  const anchorId = sm.appendCustomEntry("recovery_fixture_anchor", { fixture: true });
  const markerId = sm.appendCustomEntry(RESET_MARKER_TYPE, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command: "execute", workflowPhase: "execution", invocationMode: "execution-start", sessionId, lifecycleId, cycle: 1 });
  sm.appendCustomEntry(RESET_STATE_TYPE, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: "compacting", markerId, command: "execute", workflowPhase: "execution", invocationMode: "execution-start", sessionId, lifecycleId, cycle: 1 });
  sm.appendCompaction("", markerId, 100, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command: "execute", workflowPhase: "execution", invocationMode: "execution-start", sessionId, lifecycleId, cycle: 1 }, true, resetCompactionInstructions(requestId));
  sm.appendCustomEntry(RESET_STATE_TYPE, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: "prepare_pending", mode: "compaction", command: "execute", workflowPhase: "execution", invocationMode: "execution-start", sessionId, lifecycleId, cycle: 1 });
  sm.appendCustomMessageEntry(RESET_MESSAGE_TYPE, "<skill>poisoned execution</skill>", false, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command: "execute", workflowPhase: "execution", invocationMode: "execution-start", sessionId, lifecycleId, cycle: 1 });
  sm.appendCustomEntry(EXECUTION_STATE_ENTRY_TYPE, { source: "prime-ralph", protocolVersion: 1, sessionId, transition: 1, phase: "execution", status: "running", lifecycleId, cycle: 1, driverGoalId: "poison-driver", pendingDecision: null, pendingRound: null, admittedContinuation: null, wait: null, provenanceId: null, forwardConfirmed: false });
  sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "goal-complete", name: "goal", arguments: { action: "complete" } }], api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() });
  sm.appendCustomEntry(RESET_STATE_TYPE, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: "failed", reason: "missing_normal_turn_end", boundaryExists: true, command: "execute", workflowPhase: "execution", invocationMode: "execution-start", sessionId, lifecycleId, cycle: 1 });
  sm.appendCustomEntry(EXECUTION_STATE_ENTRY_TYPE, { source: "prime-ralph", protocolVersion: 1, sessionId, transition: 2, phase: "execution", status: "paused", lifecycleId, cycle: 1, driverGoalId: "poison-driver", pendingDecision: null, pendingRound: null, admittedContinuation: null, wait: null, provenanceId: null, forwardConfirmed: false, pauseReason: "execution agent ended without normal closeout" });
  if (legacy) for (const entry of sm.getEntries()) {
    const evidence = entry.type === "custom_message" ? entry.details : entry.type === "compaction" ? entry.details : entry.data;
    if (evidence?.requestId !== requestId) continue;
    evidence.protocolVersion = 2;
    if (entry.type !== "custom_message") for (const field of ["workflowPhase", "invocationMode", "sessionId", "lifecycleId", "cycle", "provenanceId"]) delete evidence[field];
    if (entry.type === "compaction") entry.customInstructions = `prime-ralph-reset:v2:${requestId}`;
  }
  let valuableSummaryId = null, valuableConversationId = null, unrelatedGoalId = null;
  if (postCompacted) {
    const roundRequestId = "post-compaction-poison", roundIdentity = { workflowPhase: "execution", invocationMode: "execution-continue", sessionId, lifecycleId, cycle: 2 };
    const roundMarkerId = sm.appendCustomEntry(RESET_MARKER_TYPE, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: roundRequestId, command: "execute-round", ...roundIdentity });
    sm.appendCustomEntry(RESET_STATE_TYPE, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: roundRequestId, status: "compacting", markerId: roundMarkerId, command: "execute-round", ...roundIdentity });
    sm.appendCompaction("", roundMarkerId, 200, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: roundRequestId, command: "execute-round", ...roundIdentity }, true, resetCompactionInstructions(roundRequestId));
    sm.appendCustomEntry(RESET_STATE_TYPE, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: roundRequestId, status: "prepare_pending", mode: "compaction", command: "execute-round", ...roundIdentity });
    sm.appendCustomMessageEntry(RESET_MESSAGE_TYPE, "<skill>poisoned continuation</skill>", false, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: roundRequestId, command: "execute-round", ...roundIdentity });
    sm.appendCustomEntry(EXECUTION_STATE_ENTRY_TYPE, { source: "prime-ralph", protocolVersion: 1, sessionId, transition: 3, phase: "execution", status: "running", lifecycleId, cycle: 2, driverGoalId: "poison-driver", pendingDecision: null, pendingRound: null, admittedContinuation: null, wait: null, provenanceId: null, forwardConfirmed: false });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "provider failed" }], api: model.api, provider: model.provider, model: model.id, stopReason: "error", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() });
    const terminalId = sm.appendCustomEntry(RESET_STATE_TYPE, { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: roundRequestId, status: "failed", reason: "provider_error", boundaryExists: true, command: "execute-round", ...roundIdentity });
    valuableSummaryId = sm.appendCompaction("valuable compacted history", terminalId, 500, { readFiles: [], modifiedFiles: [] }, false);
    valuableConversationId = sm.appendMessage({ role: "user", content: [{ type: "text", text: "valuable later conversation" }], timestamp: Date.now() });
    sm.appendCustomEntry("thread_goal_state", { active: false, status: "idle", goalId: "poison-driver", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 });
    sm.appendCustomEntry(EXECUTION_STATE_ENTRY_TYPE, { source: "prime-ralph", protocolVersion: 1, sessionId, transition: 4, phase: "planning", status: "inactive", lifecycleId, cycle: 2, driverGoalId: "poison-driver", pendingDecision: null, pendingRound: null, wait: null, provenanceId: null, forwardConfirmed: false, resetRequested: true, admittedContinuation: { identity: "poison-driver:1", goalId: "poison-driver", continuationsUsed: 1, cycle: 2, mode: "execution-continue", automaticCompactionRequestId: roundRequestId }, pauseReason: "session quit" });
    unrelatedGoalId = sm.appendCustomEntry("thread_goal_state", { active: true, status: "active", goalId: "unrelated-goal", objective: "preserve me", tokensUsed: 1, timeUsedSeconds: 1, continuationsUsed: 0 });
  }
  const priorLeafId = sm.getLeafId(); sm.materializeSessionFile(sessionDir); sm.flushNow();
  const auth = AuthStorage.inMemory(); auth.set("acceptance", { type: "api_key", key: "not-a-real-key" });
  const registry = ModelRegistry.inMemory(auth), settings = SettingsManager.inMemory({ compaction: { enabled: false }, goals: { enabled: false } });
  const extensions = [join(cwd, ".prime/agent/extensions/prime-ralph/index.js"), ...(cancel ? [cancelPath] : [])];
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: extensions, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "RECOVERY_BASELINE" });
  await loader.reload(); if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
  const provisioner = new IpythonKernelProvisioner(cwd, { sessionId }), ipython = createIpythonTool(cwd, { provisioner });
  const kernel = await provisioner.ensure(); await kernel.execute('RECOVERY_SENTINEL = "alive"');
  let providerCalls = 0; const agent = new Agent({ initialState: { systemPrompt: "RECOVERY_BASELINE", model, thinkingLevel: "off", serviceTier: "auto", messages: sm.buildSessionContext().messages, tools: [] }, convertToLlm,
    transformContext: async (messages) => session ? session._extensionRunner.emitContext(messages) : messages, streamFn: async () => { providerCalls += 1; throw new Error("provider must not run during recovery"); }, sessionId });
  let session = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, customTools: [ipython], initialActiveToolNames: ["ipython"], allowedToolNames: ["ipython", "ralph_lifecycle"], includeGoals: false, includeCompactSkill: false });
  const notices = []; const uiContext = new Proxy({ notify: (...args) => notices.push(args) }, { get: (target, key) => target[key] ?? (() => undefined) });
  await session.bindExtensions({ uiContext, commandContextActions: {
    waitForIdle: () => agent.waitForIdle(),
    newSession: (options) => session.newSession(options), fork: (entryId, options) => session.fork(entryId, options),
    navigateTree: (targetId, options) => session.navigateTree(targetId, options), switchSession: (path, options) => session.switchSession(path, options),
    reload: () => session.reload(),
  } }); await waitFor(() => !session.isStreaming, "extension startup");
  const commandSurface = session._extensionRunner?.runtime?.getCommands?.() ?? [];
  let preflight; try { preflight = planRalphRecovery({ branch: sm.getBranch(), entries: sm.getEntries(), sessionId, leafId: sm.getLeafId() }); } catch (error) { preflight = { error: error.message }; }
  const sessionFile = sm.getSessionFile(), beforeBytes = await readFile(sessionFile), specBefore = await readFile(specPath, "utf8"), planBefore = await readFile(planPath, "utf8"), entryCount = sm.getEntries().length;
  await session.prompt("/ralph-recover"); await waitFor(() => !session.isStreaming, "recovery command");
  const afterBytes = await readFile(sessionFile), names = await provisioner.listNamespaceNames(), sentinel = await kernel.execute("print(RECOVERY_SENTINEL)");
  return { cwd, session, sm, provisioner, sessionId, sessionFile, anchorId, priorLeafId, beforeBytes, afterBytes, entryCount, providerCalls: () => providerCalls, specPath, planPath, specBefore, planBefore, mutationPath, names, sentinel, preflight, commandSurface, notices, valuableSummaryId, valuableConversationId, unrelatedGoalId };
}

const success = await fixture();
const successEntries = success.sm.getEntries(), successBranch = success.sm.getBranch(), recovery = successBranch.find((entry) => entry.customType === RECOVERY_STATE_TYPE), recoveredState = successBranch.at(-1)?.data;
const successChecks = {
  primeAgentVersion: JSON.parse(await readFile(join(primeRoot, "package.json"), "utf8")).version === "0.9.1",
  commandRegistered: success.commandSurface.some((command) => command.name === "ralph-recover"),
  exactCandidate: success.preflight?.kind === "navigate" && success.preflight.candidate.anchorId === success.anchorId && success.preflight.priorLeafId === success.priorLeafId,
  appendOnlyPrefix: success.afterBytes.subarray(0, success.beforeBytes.length).equals(success.beforeBytes),
  sameSession: success.sm.getSessionId() === success.sessionId && success.sm.getSessionFile() === success.sessionFile,
  exactRecoveredLeaf: successBranch.at(-1)?.id === success.sm.getLeafId() && successBranch.at(-2)?.id === recovery?.id && successBranch.some((entry) => entry.id === success.anchorId),
  abandonedTailRetained: successEntries.some((entry) => entry.id === success.priorLeafId) && !successBranch.some((entry) => entry.id === success.priorLeafId),
  provenanceThenInactive: recovery?.data?.status === "navigation-verified" && recoveredState?.phase === "planning" && recoveredState?.status === "inactive" && recoveredState?.recoveryRequired?.recoveryId === recovery?.data?.recoveryId,
  noProviderGoalDriver: success.providerCalls() === 0 && recoveredState?.driverGoalId == null && !successEntries.some((entry) => entry.customType === "thread_goal_state"),
  replPreserved: success.names?.includes("RECOVERY_SENTINEL") === true && JSON.stringify(success.sentinel).includes("alive"),
  worktreePreserved: await readFile(success.specPath, "utf8") === success.specBefore && await readFile(success.planPath, "utf8") === success.planBefore && await readFile(success.mutationPath, "utf8") === "filesystem and issue-state sentinel\n",
  noticeAfterDurableState: success.notices.at(-1)?.[0]?.includes("Inspect the worktree, active planning documents, and issue state") === true,
};
const countAfterSuccess = success.sm.getEntries().length; await success.session.prompt("/ralph-recover"); await waitFor(() => !success.session.isStreaming, "idempotent recovery");
successChecks.idempotent = success.sm.getEntries().length === countAfterSuccess && success.providerCalls() === 0;

const inPlace = await fixture({ postCompacted: true });
const inPlaceEntries = inPlace.sm.getEntries(), inPlaceBranch = inPlace.sm.getBranch();
const inPlaceRecovery = inPlaceBranch.findLast((entry) => entry.customType === RECOVERY_STATE_TYPE);
const inPlaceState = inPlaceBranch.findLast((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE)?.data;
const latestGoal = inPlaceBranch.findLast((entry) => entry.customType === "thread_goal_state")?.data;
const inPlaceChecks = {
  inPlaceCandidate: inPlace.preflight?.kind === "append-in-place-provenance" && inPlace.preflight.candidate?.requestId === "post-compaction-poison",
  inPlacePrefix: inPlace.afterBytes.subarray(0, inPlace.beforeBytes.length).equals(inPlace.beforeBytes),
  inPlaceBranchPreserved: inPlaceBranch.some((entry) => entry.id === inPlace.preflight?.priorLeafId) && inPlaceBranch[inPlaceBranch.indexOf(inPlaceRecovery) - 1]?.id === inPlaceRecovery?.parentId,
  inPlaceSummaryAndConversation: inPlaceBranch.some((entry) => entry.id === inPlace.valuableSummaryId) && inPlaceBranch.some((entry) => entry.id === inPlace.valuableConversationId),
  inPlaceProvenance: inPlaceRecovery?.data?.status === "in-place-verified" && inPlaceRecovery?.data?.recoveryMode === "in-place",
  inPlaceCleanState: inPlaceState?.phase === "planning" && inPlaceState?.status === "inactive" && inPlaceState?.lifecycleId == null && inPlaceState?.cycle === 0 && inPlaceState?.driverGoalId == null && inPlaceState?.resetRequested === false && inPlaceState?.pauseReason == null && inPlaceState?.pendingDecision == null && inPlaceState?.pendingRound == null && inPlaceState?.wait == null && inPlaceState?.cancellation == null && inPlaceState?.block == null && inPlaceState?.completion == null,
  unrelatedGoalPreserved: latestGoal?.goalId === "unrelated-goal" && latestGoal?.status === "active" && inPlaceEntries.filter((entry) => entry.customType === "thread_goal_state").length === 2,
  inPlaceNoProvider: inPlace.providerCalls() === 0,
};
const countBeforeReload = inPlaceEntries.length;
await inPlace.session.reload(); await waitFor(() => !inPlace.session.isStreaming, "recovery reload");
await inPlace.session.prompt("/ralph-recover"); await waitFor(() => !inPlace.session.isStreaming, "idempotent recovery after reload");
inPlaceChecks.inPlaceReloadIdempotent = inPlace.sm.getEntries().length === countBeforeReload && inPlace.providerCalls() === 0;

const legacy = await fixture({ legacy: true });
const legacyChecks = { legacyV2RecoveredNatively: legacy.preflight?.kind === "navigate" && legacy.sm.getLeafId() === legacy.sm.getBranch().at(-1)?.id && legacy.sm.getBranch().at(-1)?.data?.recoveryRequired?.protocolVersion === 1 && legacy.providerCalls() === 0 };
const cancelled = await fixture({ cancel: true });
const cancelChecks = { cancelledSessionUnchanged: cancelled.sm.getSessionId() === cancelled.sessionId && cancelled.sm.getSessionFile() === cancelled.sessionFile, cancelledLeafUnchanged: cancelled.sm.getLeafId() === cancelled.priorLeafId, cancelledBytesUnchanged: cancelled.afterBytes.equals(cancelled.beforeBytes), cancelledNoRecoveryAppend: cancelled.sm.getEntries().length === cancelled.entryCount && !cancelled.sm.getEntries().some((entry) => entry.customType === RECOVERY_STATE_TYPE), cancelledNoProvider: cancelled.providerCalls() === 0 };
await success.session.disposeAsync({ kernelSnapshot: false }); await inPlace.session.disposeAsync({ kernelSnapshot: false }); await legacy.session.disposeAsync({ kernelSnapshot: false }); await cancelled.session.disposeAsync({ kernelSnapshot: false });
const checks = { ...successChecks, ...inPlaceChecks, ...legacyChecks, ...cancelChecks }; const failures = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
if (failures.length) { console.error(JSON.stringify({ checks, failures }, null, 2)); process.exit(1); }
console.log(JSON.stringify(checks, null, 2));
