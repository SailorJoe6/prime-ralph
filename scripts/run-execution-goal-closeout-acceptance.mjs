import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXECUTION_STATE_ENTRY_TYPE } from "../src/execution.js";
import { RESET_MESSAGE_TYPE, RESET_STATE_TYPE } from "../src/reset-context.js";

const primeRoot = process.env.PRIME_AGENT_ROOT;
if (!primeRoot) throw new Error("PRIME_AGENT_ROOT is required");
const imp = (path) => import(pathToFileURL(join(primeRoot, "dist", path)).href);
const ai = await import(pathToFileURL(join(primeRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const [{ createAgentSession }, { SessionManager }, { SettingsManager }, { AuthStorage }, { ModelRegistry }, { DefaultResourceLoader }] = await Promise.all([
  imp("core/sdk.js"), imp("core/session-manager.js"), imp("core/settings-manager.js"), imp("core/auth-storage.js"), imp("core/model-registry.js"), imp("core/resource-loader.js"),
]);
const { registerFauxProvider, fauxAssistantMessage, fauxToolCall } = ai;
const primeAgentVersion = JSON.parse(await readFile(join(primeRoot, "package.json"), "utf8")).version;
assert.equal(primeAgentVersion, "0.9.3", "this acceptance is pinned to public Prime Agent 0.9.3 behavior");

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + Number(process.env.PRIME_RALPH_ACCEPT_TIMEOUT_MS ?? 30_000);
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const text = (message) => typeof message?.content === "string" ? message.content :
  Array.isArray(message?.content) ? message.content.map((part) => part?.text ?? part?.output ?? "").join("\n") : "";
const visible = (context) => [context.systemPrompt, ...context.messages.map(text)].join("\n");
const invocation = (value) => {
  const matches = [...value.matchAll(/<prime-ralph-invocation>(.*?)<\/prime-ralph-invocation>/gs)];
  return matches.length ? JSON.parse(matches.at(-1)[1]) : null;
};
const latestState = (entries) => entries.filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data;
const normalAssistant = (message) => message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" &&
  !message.content?.some?.((part) => part?.type === "toolCall");

const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-goal-closeout-acceptance-"));
const agentDir = join(cwd, ".agent"), sessionDir = join(cwd, "sessions");
for (const directory of [
  ".ralph/skills/prepare", ".ralph/skills/spec-it-out", ".ralph/skills/plan", ".ralph/skills/execute", ".ralph/skills/blocked",
  ".ralph/plans/blocked", ".ralph/plans/archive", ".prime/agent/extensions", ".agent", "sessions",
]) await mkdir(join(cwd, directory), { recursive: true });
const sourceRoot = process.env.PRIME_RALPH_SOURCE_ROOT ?? fileURLToPath(new URL("../src", import.meta.url));
const { default: workflowExtension } = await import(pathToFileURL(join(sourceRoot, "index.js")).href);
for (const name of ["prepare", "spec-it-out", "plan", "execute", "blocked"]) {
  await writeFile(join(cwd, `.ralph/skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: acceptance\n${name === "prepare" ? "" : "prime-ralph-invocation-version: 1\n"}---\n${name} acceptance\n`);
}
await writeFile(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# public goal closeout specification\n");
await writeFile(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# public goal closeout plan\n");

const extensionTrace = [], contextAttempts = [], contextProviderTimeline = [], providerContexts = [];
const rejectBoundaryMode = process.argv.includes("--reject-boundary");
const extensionErrors = [];
let publicExtensionContext = null, terminalGoalCompletion = null, inputPause = null;
const observer = (pi) => {
  for (const type of ["agent_start", "before_agent_start", "turn_end", "agent_end"]) {
    pi.on(type, (event, ctx) => {
      publicExtensionContext = ctx;
      const message = type === "agent_end" ? [...(event?.messages ?? [])].reverse().find((entry) => entry?.role === "assistant") : event?.message;
      extensionTrace.push({ type, role: message?.role, stopReason: message?.stopReason, text: text(message).slice(0, 80) });
    });
  }
  pi.on("context", (event) => {
    const goalIndex = event.messages.findLastIndex((message) => message?.role === "custom" && message.customType === "goal_context" && message.details?.kind === "continuation");
    const observation = {
      kind: "context", goalId: goalIndex < 0 ? null : event.messages[goalIndex].details.goalId,
      continuationsUsed: goalIndex < 0 ? null : event.messages[goalIndex].details.continuationsUsed,
      adjacentNormalAssistant: goalIndex < 0 ? null : normalAssistant(event.messages[goalIndex - 1]),
      adjacentAssistantText: goalIndex < 0 ? null : text(event.messages[goalIndex - 1]).slice(0, 80),
      terminalGoalContext: goalIndex >= 0 && goalIndex === event.messages.length - 1,
    };
    contextAttempts.push(observation); contextProviderTimeline.push(observation);
    if (rejectBoundaryMode && observation.continuationsUsed === 2 && observation.terminalGoalContext === true && inputPause === null) {
      inputPause = session.acquireSessionInputPause();
    }
  });
};

const settings = SettingsManager.inMemory({
  compaction: { enabled: false }, goals: { enabled: true, maxContinuations: 2 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
});
const loader = new DefaultResourceLoader({
  cwd, agentDir, settingsManager: settings,
  extensionFactories: [observer, workflowExtension],
  noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "public Prime Ralph closeout acceptance",
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, [], "the fixture extensions must load cleanly");

const faux = registerFauxProvider({ provider: "prime-ralph-goal-closeout" }), model = faux.getModel();
const auth = AuthStorage.inMemory(); auth.setRuntimeApiKey(model.provider, "faux-key");
const registry = ModelRegistry.inMemory(auth);
registry.registerProvider(model.provider, {
  baseUrl: model.baseUrl, apiKey: "faux-key", api: faux.api,
  models: faux.models.map((entry) => ({
    id: entry.id, name: entry.name, api: entry.api, reasoning: entry.reasoning, input: entry.input, cost: entry.cost,
    contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, baseUrl: entry.baseUrl,
  })),
});
const sessionManager = SessionManager.create(cwd, sessionDir), stages = new Map();
const stateNow = () => latestState(sessionManager.getEntries());
const responseFactory = async (context, options) => {
  const meta = invocation(visible(context));
  providerContexts.push({ cycle: meta?.cycle ?? null, skill: meta?.skill ?? null, signalAbortedAtEntry: options?.signal?.aborted === true });
  contextProviderTimeline.push({ kind: "provider", cycle: meta?.cycle ?? null });
  if (meta?.skill !== "execute") return fauxAssistantMessage("planning startup complete");
  const stage = stages.get(meta.cycle) ?? 0; stages.set(meta.cycle, stage + 1);
  if (meta.cycle === 2) {
    if (terminalGoalCompletion === null) {
      assert.ok(publicExtensionContext, "the public extension must observe the replacement run before its provider call");
      const ipython = session.getToolDefinition("ipython");
      assert.ok(ipython, "the public session must expose its enabled IPython tool");
      terminalGoalCompletion = ipython.execute(
        "acceptance-terminal-goal-complete",
        { code: "await goal.complete()\nprint('TERMINAL_GOAL_COMPLETE')" },
        undefined,
        undefined,
        publicExtensionContext,
      );
      const result = await terminalGoalCompletion;
      assert.equal(result.isError, false, "the terminal barrier must complete its fixture goal through public IPython");
    }
    return fauxAssistantMessage("CYCLE2_TERMINAL_BARRIER");
  }
  if (meta.cycle !== 1) return fauxAssistantMessage("later-cycle provider call is outside this closeout acceptance");
  if (stage === 0) return fauxAssistantMessage(fauxToolCall("ipython", { code: "await goal.create('old public retry goal')\nprint('OLD_GOAL_CREATED')" }), { stopReason: "toolUse" });
  if (stage === 1) return fauxAssistantMessage(fauxToolCall("ipython", { code: "await goal.complete()\nprint('OLD_GOAL_COMPLETE')" }), { stopReason: "toolUse" });
  if (stage === 2) return fauxAssistantMessage(fauxToolCall("ralph_lifecycle", { action: "wait", lifecycleId: meta.lifecycleId, cycle: 1, reason: "public retry fixture", readiness: "replacement goal exists" }), { stopReason: "toolUse" });
  if (stage === 3) return fauxAssistantMessage("READY_WAIT_CLOSEOUT");
  if (stage === 4) return fauxAssistantMessage(fauxToolCall("ipython", { code: "await goal.create('replacement public retry goal')\nprint('NEW_GOAL_CREATED')" }), { stopReason: "toolUse" });
  if (stage === 5) return fauxAssistantMessage(fauxToolCall("ralph_lifecycle", { action: "ready", lifecycleId: meta.lifecycleId, cycle: 1, waitId: stateNow()?.wait?.id }), { stopReason: "toolUse" });
  if (stage === 6) return fauxAssistantMessage("READY_CLOSEOUT");
  if (stage === 7) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "WebSocket closed 1006" });
  if (stage === 8) return fauxAssistantMessage(fauxToolCall("ralph_lifecycle", { action: "continue", lifecycleId: meta.lifecycleId, cycle: 1 }), { stopReason: "toolUse" });
  return fauxAssistantMessage(`CYCLE1_CLOSEOUT ${"context ".repeat(45_000)}`);
};
faux.setResponses(Array.from({ length: 24 }, () => responseFactory));

const { session } = await createAgentSession({
  cwd, agentDir, model, settingsManager: settings, sessionManager, authStorage: auth, modelRegistry: registry, resourceLoader: loader,
  tools: ["ipython", "ralph_lifecycle"], includeGoals: true, includeCompactSkill: false, thinkingLevel: "off", rlmDepth: 0,
});
const originalSessionId = sessionManager.getSessionId();
const sessionEvents = [];
session.subscribe((event) => {
  if (event.type === "auto_retry_start") sessionEvents.push(`retry-start:${event.attempt}`);
  if (event.type === "auto_retry_end") sessionEvents.push(`retry-end:${event.success}`);
});

try {
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  await waitFor(() => providerContexts.length >= 1 && !session.isStreaming && session.queuedActionCount === 0, "planning startup");
  for (let index = 0; index < 3; index += 1) await session.promptAndWait(`STALE_${index} ${"old context ".repeat(3500)}`);
  await session.promptAndWait("/execute");
  await waitFor(() => stateNow()?.status === "waiting" && !session.isStreaming, "waiting state");
  await session.prompt("READINESS AVAILABLE");
  if (rejectBoundaryMode) {
    await waitFor(() => extensionErrors.some((error) => error?.event === "send_message" && /session input admission is paused/.test(error?.error ?? "")), "public send-message rejection");
    const strandedRound = stateNow()?.pendingRound;
    assert.equal(strandedRound?.stage, "admission-requested");
    const providerCallsBeforeReconciliation = faux.state.callCount;
    inputPause.release(); inputPause = null;
    await waitFor(() => !session.isStreaming && session.queuedActionCount === 0, "rejected queue drain");
    await session.prompt("RECONCILE_REJECTED_BOUNDARY");
    await waitFor(() => stateNow()?.pendingRound?.stage === "failed", "provider-free input reconciliation");
    assert.equal(faux.state.callCount, providerCallsBeforeReconciliation);
    const failedEntries = sessionManager.getEntries();
    const failedState = stateNow();
    const failedRound = failedState.pendingRound;
    assert.equal(failedRound.requestId, strandedRound.requestId);
    const failedReset = [...failedEntries].reverse().find((entry) => entry.customType === RESET_STATE_TYPE && entry.data?.requestId === failedRound.requestId)?.data;
    assert.equal(failedState.status, "paused");
    assert.equal(failedState.cycle, 1);
    assert.equal(failedState.compactionHalted, true);
    assert.equal(failedState.resumeBlocked, true);
    assert.equal(failedReset?.status, "failed");
    assert.equal(failedReset?.reason, "skill_boundary_delivery_missing");
    assert.equal(failedEntries.some((entry) => entry.type === "custom_message" && entry.customType === RESET_MESSAGE_TYPE && entry.details?.automaticCompactionRequestId === failedRound.requestId), false);
    assert.equal(providerContexts.some((entry) => entry.cycle === 2), false);
    assert.equal(sessionManager.getSessionId(), originalSessionId);
    const providerCallsBeforeRecovery = faux.state.callCount;
    await session.prompt("/goal clear");
    await waitFor(() => session.goalState.status === "idle", "provider-free goal clear");
    await session.promptAndWait("OPERATOR_CONTROL_RESTORED");
    await waitFor(() => !session.isStreaming && session.queuedActionCount === 0, "ordinary operator turn after recovery");
    const recoveredState = stateNow();
    assert.equal(faux.state.callCount, providerCallsBeforeRecovery + 1);
    assert.equal(recoveredState.phase, "planning");
    assert.equal(recoveredState.status, "inactive");
    assert.equal(recoveredState.pendingRound, null);
    assert.equal(recoveredState.cycle, 1);
    console.log(JSON.stringify({
      primeAgentVersion: true, publicSdkOnly: true, rejectedBoundaryObserved: true,
      noBoundaryForged: true, providerFreeInputReconciliation: true, boundedFailure: true, providerFreeGoalClear: true,
      operatorControlRestored: true, noCycleAdvance: true, sameSession: true,
      lifecycleId: failedState.lifecycleId, requestId: failedRound.requestId,
    }, null, 2));
  } else {
    await waitFor(() => sessionManager.getEntries().some((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE && entry.data?.cycle === 2), "cycle two admission after provider retry");
    await waitFor(() => providerContexts.filter((entry) => entry.cycle === 2).length === 1 &&
      extensionTrace.some((event) => event.type === "agent_end" && event.stopReason === "stop" && event.text === "CYCLE2_TERMINAL_BARRIER") &&
      !session.isStreaming && session.queuedActionCount === 0,
      "one normally settled cycle-two provider turn");
    await new Promise((resolve) => setImmediate(resolve));

    const entries = sessionManager.getEntries(), states = entries.filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).map((entry) => entry.data);
    const lifecycleIds = new Set(states.map((state) => state.lifecycleId).filter(Boolean));
    assert.equal(lifecycleIds.size, 1, "the public trace must retain one lifecycle");
    assert.equal(stages.get(1), 10, "cycle one must execute the exact Wait/Ready/error/retry/Continue response sequence");
    assert.deepEqual(sessionEvents, ["retry-start:1", "retry-end:true"], "Prime Agent must own one successful automatic retry");

    const readyPending = states.find((state) => state.pendingDecision?.action === "ready");
    const readyAdmitted = states.find((state) => state.cycle === 1 && state.admittedContinuation?.continuationsUsed === 1);
    assert.ok(readyPending && readyAdmitted, "Ready must close and admit the replacement goal");
    assert.equal(readyAdmitted.status, "running"); assert.equal(readyAdmitted.cycle, 1);
    assert.equal(readyAdmitted.admittedContinuation.identity, `${readyAdmitted.driverGoalId}:1`);

    const retryPauseIndex = states.findIndex((state) => state.pauseReason === "execution agent ended without normal closeout");
    assert.ok(retryPauseIndex >= 0, "the transient provider error must create the exact fail-closed pause");
    assert.equal(states[retryPauseIndex + 1]?.status, "running", "retry agent_start must reconcile the exact same-goal pass");
    assert.equal(states[retryPauseIndex + 1]?.cycle, 1);
    const continued = states.find((state) => state.pendingDecision?.action === "continue" && typeof state.pendingDecision.finalAssistantMessage === "string");
    assert.ok(continued?.pendingDecision.finalAssistantMessage.startsWith("CYCLE1_CLOSEOUT"), "the retry run must commit its normal final assistant");
    const cycleTwoAdmissions = states.filter((state, index) => state.cycle === 2 && states[index - 1]?.cycle === 1);
    assert.equal(cycleTwoAdmissions.length, 1, "the native continuation must advance the cycle exactly once");
    assert.equal(cycleTwoAdmissions[0].status, "running");
    assert.equal(states.at(-1).cycle, 2); assert.equal(states.at(-1).status, "paused");
    assert.equal(states.at(-1).pauseReason, "execution pass ended without a lifecycle decision",
      "the normally settled terminal fixture assistant intentionally makes no cycle-two lifecycle decision");
    assert.ok(terminalGoalCompletion, "the terminal fixture must complete its goal through the public IPython tool");
    assert.equal(session.goalState.status, "complete");
    assert.equal(states.some((state) => state.pauseReason === "native continuation arrived before lifecycle closeout"), false);

    const errorTurn = extensionTrace.findIndex((event) => event.type === "turn_end" && event.stopReason === "error");
    const retryStart = extensionTrace.findIndex((event, index) => index > errorTurn && event.type === "agent_start");
    assert.ok(errorTurn >= 0 && retryStart > errorTurn);
    assert.equal(extensionTrace.slice(errorTurn + 1, retryStart).some((event) => event.type === "before_agent_start"), false,
      "Prime Agent's direct retry must be characterized without a before_agent_start event");

    const goalContexts = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "goal_context" && entry.details?.kind === "continuation");
    assert.deepEqual(goalContexts.map((entry) => entry.details.continuationsUsed), [1, 2]);
    assert.equal(goalContexts[0].details.goalId, goalContexts[1].details.goalId);
    for (const [sentinel, goalContext] of [["READY_CLOSEOUT", goalContexts[0]], ["CYCLE1_CLOSEOUT", goalContexts[1]]]) {
      const assistantIndex = entries.findIndex((entry) => entry.type === "message" && entry.message?.role === "assistant" && text(entry.message).startsWith(sentinel));
      const contextIndex = entries.indexOf(goalContext);
      assert.ok(assistantIndex >= 0 && contextIndex > assistantIndex);
      assert.ok(entries.slice(assistantIndex + 1, contextIndex).some((entry) => entry.type === "custom" && entry.customType === "thread_goal_state"),
        "durable goal accounting must remain between the normal assistant and host goal_context");
    }
    const observedGoalContexts = contextAttempts.filter((attempt) => attempt.goalId);
    for (const [continuationsUsed, sentinel] of [[1, "READY_CLOSEOUT"], [2, "CYCLE1_CLOSEOUT"]]) {
      const decisive = observedGoalContexts.find((attempt) => attempt.continuationsUsed === continuationsUsed &&
        attempt.terminalGoalContext === true && attempt.adjacentNormalAssistant === true && attempt.adjacentAssistantText.startsWith(sentinel));
      assert.ok(decisive, `continuation ${continuationsUsed} must have one source-proven decisive context attempt`);
    }

    const readyContextTimelineIndex = contextProviderTimeline.findIndex((event) => event.kind === "context" && event.continuationsUsed === 1);
    const continueContextTimelineIndex = contextProviderTimeline.findIndex((event) => event.kind === "context" && event.continuationsUsed === 2);
    assert.equal(contextProviderTimeline[readyContextTimelineIndex + 1]?.kind, "provider", "Ready must admit the same-cycle goal continuation");
    assert.equal(contextProviderTimeline.slice(continueContextTimelineIndex + 1).some((event) => event.kind === "context"), true,
      "Continue must consume the raw goal continuation and schedule a replacement boundary");

    const roundBoundaries = entries.filter((entry) => entry.type === "custom_message" && entry.customType === RESET_MESSAGE_TYPE && entry.details?.command === "execute-round");
    const roundCompactions = entries.filter((entry) => entry.type === "compaction" && entry.details?.command === "execute-round");
    assert.equal(roundBoundaries.length, 1); assert.equal(roundCompactions.length, 1);
    const requestId = roundBoundaries[0].details.automaticCompactionRequestId;
    assert.equal(roundCompactions[0].details.requestId, requestId);
    assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === RESET_STATE_TYPE && entry.data?.requestId === requestId && entry.data.status === "compacting"));
    const roundResetStates = entries.filter((entry) => entry.type === "custom" && entry.customType === RESET_STATE_TYPE && entry.data?.requestId === requestId).map((entry) => entry.data);
    assert.equal(roundResetStates.filter((state) => state.status === "completed").length, 1);
    assert.equal(roundResetStates.some((state) => state.status === "failed"), false);
    const cycleTwoProviders = providerContexts.filter((entry) => entry.cycle === 2);
    assert.equal(cycleTwoProviders.length, 1, "the replacement boundary must enter Faux exactly once before teardown");
    assert.equal(cycleTwoProviders[0].signalAbortedAtEntry, false, "the replacement provider must own a fresh non-aborted signal");
    const terminalAssistant = entries.find((entry) => entry.type === "message" && entry.message?.role === "assistant" && text(entry.message) === "CYCLE2_TERMINAL_BARRIER")?.message;
    assert.equal(terminalAssistant?.stopReason, "stop", "the cycle-two provider response must settle normally");
    assert.ok(extensionTrace.some((event) => event.type === "agent_end" && event.stopReason === "stop" && event.text === "CYCLE2_TERMINAL_BARRIER"),
      "the terminal barrier must reach agent_end before fixture disposal");

    const executionLog = await readFile(join(cwd, ".ralph/logs/EXECUTION_LOG.md"), "utf8");
    assert.equal((executionLog.match(/\| phase=execute \| cycle=1/g) ?? []).length, 1);
    assert.equal(executionLog.includes("CYCLE1_CLOSEOUT"), true);

    console.log(JSON.stringify({
      primeAgentVersion: true, publicSdkOnly: true, realGoalCalls: true, durableGoalStateOrdering: true,
      providerContextAdjacency: true, readySameCycle: true, retryWithoutBeforeAgentStart: true,
      retryCloseoutCommitted: true, noPrematureCloseoutPause: true, exactlyOneCycleAdvance: true,
      automaticBoundaryScheduled: true, freshCycleTwoSignal: true, terminalBarrierSettled: true,
      lifecycleId: [...lifecycleIds][0], contextAttempts: contextAttempts.length,
      providerCallsObserved: faux.state.callCount,
    }, null, 2));
  }
} catch (error) {
  if (process.env.PRIME_RALPH_ACCEPT_DEBUG === "1") console.error(JSON.stringify({
    error: error.message, providerContexts, contextAttempts, extensionTrace: extensionTrace.slice(-30),
    resets: sessionManager.getEntries().filter((entry) => entry.customType === RESET_STATE_TYPE).map((entry) => entry.data),
    states: sessionManager.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).map((entry) => ({
      transition: entry.data.transition, status: entry.data.status, cycle: entry.data.cycle, pauseReason: entry.data.pauseReason,
      action: entry.data.pendingDecision?.action, finalAssistantCommitted: typeof entry.data.pendingDecision?.finalAssistantMessage === "string",
      pendingRound: entry.data.pendingRound,
    })),
  }, null, 2));
  throw error;
} finally {
  inputPause?.release();
  session.dispose(); faux.unregister();
}
