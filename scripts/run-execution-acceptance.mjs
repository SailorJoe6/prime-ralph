import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXECUTION_STATE_ENTRY_TYPE } from "../src/execution.js";

const primeRoot = process.env.PRIME_AGENT_ROOT, coreRoot = process.env.PRIME_AGENT_CORE_ROOT;
if (!primeRoot || !coreRoot) throw new Error("PRIME_AGENT_ROOT and PRIME_AGENT_CORE_ROOT are required");
const imp = (path) => import(pathToFileURL(join(primeRoot, "dist", path)).href);
const [{ Agent }, { AgentSession }, { SessionManager }, { SettingsManager }, { AuthStorage }, { ModelRegistry }, { DefaultResourceLoader }, { convertToLlm }, { createIpythonTool, IpythonKernelProvisioner }] = await Promise.all([
  import(pathToFileURL(join(coreRoot, "dist/agent.js")).href), imp("core/agent-session.js"), imp("core/session-manager.js"), imp("core/settings-manager.js"), imp("core/auth-storage.js"), imp("core/model-registry.js"), imp("core/resource-loader.js"), imp("core/messages.js"), imp("core/tools/index.js"),
]);
const model = { provider: "poc", id: "fake", api: "openai-completions", contextWindow: 100000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function assistant(content, stopReason = "stop") { return { role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content, api: model.api, provider: model.provider, model: model.id, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() }; }
function response(message) { return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: message.stopReason, message }; }, async result() { return message; } }; }
const visible = (context) => context.capturedText ?? context.messages.map((message) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => part?.text ?? part?.output ?? "").join("\n") : "").join("\n");
const invocation = (value) => { const match = value.match(/<prime-ralph-invocation>(.*?)<\/prime-ralph-invocation>/s); return match ? JSON.parse(match[1]) : null; };
const waitFor = async (predicate, label) => { const deadline = Date.now() + 12_000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`); await new Promise((resolve) => setTimeout(resolve, 10)); } };

const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-execution-acceptance-")), sessionDir = join(cwd, "sessions"), agentDir = join(cwd, ".agent");
for (const dir of [".ralph/skills/prepare", ".ralph/skills/spec-it-out", ".ralph/skills/plan", ".ralph/skills/execute", ".ralph/skills/blocked", ".ralph/plans/blocked", ".ralph/plans/archive", ".prime/agent/extensions", "sessions", ".agent"]) await mkdir(join(cwd, dir), { recursive: true });
await symlink(new URL("../src", import.meta.url), join(cwd, ".prime/agent/extensions/prime-ralph"), "dir");
const sentinels = { baseline: "SLICE5_HOST_BASELINE", prepare: "SLICE5_PREPARE", execute: "SLICE5_EXECUTE", stale: "SLICE5_STALE_PLANNING", repl: "SLICE5_REPL_ALIVE", steering: "SLICE6_POST_BOUNDARY_STEERING", child: "SLICE6_RLM_SPLIT_CHILD_RESULT", pauseFeedback: "PAUSE_RESUME_FEEDBACK_MUST_SURVIVE", pauseAck: "PAUSE_RESUME_ACK_MUST_SURVIVE" };
for (const [name, body] of Object.entries({ prepare: sentinels.prepare, "spec-it-out": "spec", plan: "plan", execute: sentinels.execute, blocked: "blocked" })) await writeFile(join(cwd, `.ralph/skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: acceptance\n${name === "prepare" ? "" : "prime-ralph-invocation-version: 1\n"}---\n${body}\n`);
await writeFile(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# execution fixture specification\n");
await writeFile(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# execution fixture plan\n");
const auth = AuthStorage.inMemory(); auth.set("poc", { type: "api_key", key: "not-a-real-key" });
const registry = ModelRegistry.inMemory(auth), settings = SettingsManager.inMemory({ compaction: { enabled: false }, goals: { enabled: true, maxContinuations: 20 } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(cwd, ".prime/agent/extensions/prime-ralph/index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: sentinels.baseline });
await loader.reload(); if (loader.getExtensions().errors.length) throw new Error(`extension load failed: ${JSON.stringify(loader.getExtensions().errors)}`);
const sm = SessionManager.create(cwd, sessionDir), originalSessionId = sm.getSessionId(), originalSessionFile = sm.getSessionFile(), contexts = [];
const provisioner = new IpythonKernelProvisioner(cwd, { sessionId: originalSessionId }), ipython = createIpythonTool(cwd, { provisioner });
// The fake provider cannot call the kernel-side goal skill. These private host calls are
// fixture-only equivalents of goal.create/complete and an admitted tracked child; the
// production extension uses only public extension events, messages, state, and tools.
let hostSession, startupStage = 0, fakeRlmRun, delayedTurnEndRelease, raceBoundaryState; const cycleStages = new Map();
const agent = new Agent({ initialState: { systemPrompt: sentinels.baseline, model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] }, convertToLlm,
  transformContext: async (messages) => hostSession ? hostSession._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => {
    const content = visible(context); contexts.push({ capturedText: content }); const meta = invocation(content);
    if (meta?.cycle === 3 && !raceBoundaryState) raceBoundaryState = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data;
    if (!meta || meta.skill !== "execute") { startupStage += 1; return response(assistant("planning interaction complete")); }
    const stage = cycleStages.get(meta.cycle) ?? 0; cycleStages.set(meta.cycle, stage + 1);
    if (meta.cycle === 1 && stage === 0) {
      if (hostSession.goalState.status !== "active") hostSession._startGoal("Continue the active Ralph execution lifecycle.", 100);
      return response(assistant([{ type: "toolCall", id: "set-repl", name: "ipython", arguments: { code: `SLICE5_REPL = ${JSON.stringify(sentinels.repl)}\nprint(SLICE5_REPL)` } }], "toolUse"));
    }
    if (meta.cycle === 2 && stage === 0) return response(assistant([{ type: "toolCall", id: "cycle2-tool", name: "ipython", arguments: { code: "print('SLICE5_CYCLE2_TOOL_RESULT')" } }], "toolUse"));
    if (meta.cycle === 3 && stage === 0) {
      // Core steering models an admitted /btw or queued user input without
      // introducing a second AgentSession action lifecycle into this acceptance.
      agent.steer({ role: "user", content: sentinels.steering, timestamp: Date.now() });
      return response(assistant([{ type: "toolCall", id: "read-repl", name: "ipython", arguments: { code: "print(SLICE5_REPL)" } }], "toolUse"));
    }
    if (meta.cycle === 2 && stage === 1) return response(assistant("tracked child split this execution pass", "aborted"));
    if ((meta.cycle === 1 && stage === 1) || (meta.cycle === 2 && stage === 2) || (meta.cycle === 3 && stage === 1)) {
      const terminal = meta.cycle === 3;
      if (terminal) hostSession._completeGoalFromHost();
      return response(assistant([...(terminal ? [] : [{ type: "text", text: `cycle ${meta.cycle} compaction padding ${"context ".repeat(30000)}` }]), { type: "toolCall", id: `life-${meta.cycle}`, name: "ralph_lifecycle", arguments: { action: terminal ? "complete" : "continue", lifecycleId: meta.lifecycleId, cycle: meta.cycle, ...(terminal ? { archive: false } : {}) } }], "toolUse"));
    }
    if (meta.cycle === 1 && !fakeRlmRun) { fakeRlmRun = { settled: false }; hostSession._unsettledRlmChildRuns.add(fakeRlmRun); }
    if (meta.cycle === 2 && !delayedTurnEndRelease) {
      let release;
      const delayedTurnEnd = new Promise((resolve) => { release = resolve; });
      hostSession._agentEventQueue = hostSession._agentEventQueue.then(() => delayedTurnEnd);
      delayedTurnEndRelease = release;
    }
    const suffix = meta.cycle === 2 ? (content.includes("SLICE5_CYCLE2_TOOL_RESULT") ? " using preserved tool output" : " without tool output") : "";
    return response(assistant(`completed execution pass ${meta.cycle}${suffix}`));
  }, sessionId: originalSessionId });
hostSession = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, customTools: [ipython], initialActiveToolNames: ["ipython"], allowedToolNames: ["ipython", "ralph_lifecycle"], includeGoals: true, includeCompactSkill: false });
await hostSession.bindExtensions({}); await waitFor(() => contexts.length >= 1 && !hostSession.isStreaming, "planning startup");
await hostSession.promptAndWait(sentinels.stale);
for (let turn = 1; turn <= 3; turn += 1) await hostSession.promptAndWait(`EXECUTION_STALE_TURN_${turn}
${"old execution context ".repeat(2500)}`);
const beforeExecute = contexts.length; await hostSession.prompt("/execute");
await waitFor(() => { const state = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data; return state?.pendingDecision?.action === "continue" && typeof state.pendingDecision.finalAssistantMessage === "string" && !hostSession.isStreaming; }, "first pass waiting at native RLM barrier");
const heldContextCount = contexts.length, heldState = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1).data;
await new Promise((resolve) => setTimeout(resolve, 100));
const rlmHeld = contexts.length === heldContextCount && heldState.cycle === 1 && !(await readFile(join(cwd, ".ralph/logs/EXECUTION_LOG.md"), "utf8").catch(() => ""));
fakeRlmRun.settled = true; hostSession._maybeResumeGoalContinuationAfterRlmWork();
await waitFor(() => { const state = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data; return state?.cycle === 2 && state?.status === "paused" && state?.pauseReason === "execution agent ended without normal closeout" && !hostSession.isStreaming; }, "RLM-split execution pause");
const splitPausedState = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data;
const splitResume = hostSession.prompt(sentinels.child, { customMessage: { role: "custom", customType: "agent_message", content: sentinels.child, display: true, details: { source: "acceptance", fromRelationship: "child" }, timestamp: Date.now() } });
await waitFor(() => delayedTurnEndRelease && hostSession.goalState.continuationsUsed >= 2, "native continuation held before delayed turn_end");
const heldCloseoutState = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data;
const continuationHeldForCloseout = heldCloseoutState?.cycle === 2 && heldCloseoutState?.status === "running" && heldCloseoutState?.pendingDecision?.action === "continue" && typeof heldCloseoutState.pendingDecision.finalAssistantMessage !== "string" && !raceBoundaryState;
delayedTurnEndRelease();
await waitFor(() => raceBoundaryState, "native continuation after delayed turn_end");
await splitResume;
const continuationAdmittedAfterCloseout = raceBoundaryState.cycle === 3 && raceBoundaryState.status === "running" && raceBoundaryState.pendingDecision === null && raceBoundaryState.admittedContinuation?.cycle === 3;
await waitFor(() => { const states = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE); return states.at(-1)?.data?.status === "inactive" && states.at(-1)?.data?.pendingDecision === null && contexts.length >= beforeExecute + 7 && !hostSession.isStreaming; }, "three execution passes and completion");
const executionContexts = contexts.filter((context) => invocation(visible(context))?.skill === "execute"), metas = executionContexts.map((context) => invocation(visible(context))).filter(Boolean);
const firstByCycle = [1, 2, 3].map((cycle) => executionContexts.find((context) => invocation(visible(context))?.cycle === cycle));
const entries = sm.getEntries();
const log = await readFile(join(cwd, ".ralph/logs/EXECUTION_LOG.md"), "utf8"), states = entries.filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).map((entry) => entry.data), finalState = states.at(-1);
const automaticBoundaries = entries.filter((entry) => entry.type === "custom_message" && entry.details?.command === "execute-round");
const automaticCompactions = entries.filter((entry) => entry.type === "compaction" && entry.details?.command === "execute-round");
const automaticBoundaryOrdering = automaticBoundaries.length === 2 && automaticBoundaries.every((boundary) => {
  const requestId = boundary.details.automaticCompactionRequestId, boundaryIndex = entries.indexOf(boundary);
  const armedIndex = entries.findIndex((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE && entry.data?.pendingRound?.requestId === requestId && entry.data.pendingRound.stage === "armed");
  const markerIndex = entries.findIndex((entry) => entry.customType === "prime_ralph_reset_marker" && entry.data?.requestId === requestId);
  const compactionIndex = entries.findIndex((entry) => entry.type === "compaction" && entry.details?.requestId === requestId);
  const admissionIndex = entries.findIndex((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE && entry.data?.pendingRound?.requestId === requestId && entry.data.pendingRound.stage === "admission-requested");
  return armedIndex >= 0 && armedIndex < markerIndex && markerIndex < compactionIndex && compactionIndex < admissionIndex && admissionIndex < boundaryIndex;
});
const checks = {
  primeAgentVersion: JSON.parse(await readFile(join(primeRoot, "package.json"), "utf8")).version === "0.9.1",
  threeCycles: [1, 2, 3].every((cycle) => metas.some((meta) => meta.cycle === cycle)),
  oneLifecycle: new Set(metas.map((meta) => meta.lifecycleId)).size === 1,
  cleanOrdering: firstByCycle.every((context) => { const value = visible(context); return value.indexOf(sentinels.prepare) >= 0 && value.indexOf(sentinels.prepare) < value.indexOf(sentinels.execute) && !value.includes(sentinels.stale); }),
  automaticCompactionBeforeBoundary: automaticCompactions.length === 2 && automaticBoundaryOrdering,
  nativeGoalDriver: states.some((state) => state.driverGoalId) && hostSession.goalState.status === "complete",
  trackedRlmHeldBoundary: rlmHeld,
  rlmSplitRecovered: splitPausedState?.cycle === 2 && splitPausedState?.status === "paused" && states.some((state) => state.cycle === 2 && state.status === "running" && state.resumed === false) && contexts.some((context) => context.capturedText.includes(sentinels.child)),
  continuationHeldForCloseout,
  continuationAdmittedAfterCloseout,
  noPrematureCloseoutPause: !states.some((state) => state.pauseReason === "native continuation arrived before lifecycle closeout"),
  cycleToolTailPreserved: contexts.some((context) => context.capturedText.includes("SLICE5_CYCLE2_TOOL_RESULT")),
  postBoundarySteeringPreserved: executionContexts.some((context) => invocation(visible(context))?.cycle === 3 && context.capturedText.includes(sentinels.steering) && !context.capturedText.includes(sentinels.stale)),
  completed: finalState.phase === "planning" && finalState.status === "inactive",
  logEntries: (log.match(/^### .* \| phase=execute \| cycle=/gm) ?? []).length === 3 && [1, 2, 3].every((cycle) => log.includes(`| cycle=${cycle}`)),
  replPreserved: contexts.some((context) => visible(context).includes(sentinels.repl)) && originalSessionId === sm.getSessionId(),
  jsonlPreserved: originalSessionFile === sm.getSessionFile() && (await readFile(originalSessionFile, "utf8")).includes(EXECUTION_STATE_ENTRY_TYPE),
};
await hostSession.disposeAsync({ kernelSnapshot: false });
const failures = Object.entries(checks).filter(([key, value]) => key === "primeAgentVersion" ? !value : value !== true).map(([key]) => key);
if (failures.length) { console.error(JSON.stringify({ checks, failures, cycleStages: Object.fromEntries(cycleStages), contextCount: contexts.length, finalState }, null, 2)); process.exit(1); }
console.log(JSON.stringify({ ...checks, sessionId: originalSessionId, contextCount: contexts.length, lifecycleId: metas[0].lifecycleId }, null, 2));
