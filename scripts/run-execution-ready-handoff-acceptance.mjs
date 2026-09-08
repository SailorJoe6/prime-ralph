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
const model = { provider: "acceptance", id: "fake", api: "openai-completions", contextWindow: 120000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content, api: model.api, provider: model.provider, model: model.id, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() });
const response = (message) => ({ async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: message.stopReason, message }; }, async result() { return message; } });
const text = (context) => context.messages.map((message) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => part?.text ?? "").join("\n") : "").join("\n");
const invocation = (value) => { const matches = [...value.matchAll(/<prime-ralph-invocation>(.*?)<\/prime-ralph-invocation>/gs)]; return matches.length ? JSON.parse(matches.at(-1)[1]) : null; };
const waitFor = async (predicate, label) => { const deadline = Date.now() + 15_000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`); await new Promise((resolve) => setTimeout(resolve, 10)); } };
const latestState = (sm) => sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data;

const historicalSentinel = "HISTORICAL_READY_GOAL_CONTEXT", childSentinel = "READY_CHILD_HANDOFF", auxiliarySentinel = "READY_AUXILIARY_CONTEXT";
const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-ready-handoff-acceptance-")), sessionDir = join(cwd, "sessions"), agentDir = join(cwd, ".agent");
for (const dir of [".ralph/skills/prepare", ".ralph/skills/spec-it-out", ".ralph/skills/plan", ".ralph/skills/execute", ".ralph/skills/blocked", ".ralph/plans/blocked", ".ralph/plans/archive", ".prime/agent/extensions", "sessions", ".agent"]) await mkdir(join(cwd, dir), { recursive: true });
await symlink(new URL("../src", import.meta.url), join(cwd, ".prime/agent/extensions/prime-ralph"), "dir");
const auxiliaryExtension = join(cwd, ".prime/agent/extensions/ready-auxiliary.mjs");
await writeFile(auxiliaryExtension, `export default function (pi) { pi.on("before_agent_start", () => ({ message: { customType: "acceptance_auxiliary", content: ${JSON.stringify(auxiliarySentinel)}, display: false, details: { source: "before-agent-start" } } })); }\n`);
for (const [name, body] of Object.entries({ prepare: "READY_PREPARE", "spec-it-out": "spec", plan: "plan", execute: "READY_EXECUTE", blocked: "blocked" })) await writeFile(join(cwd, `.ralph/skills/${name}/SKILL.md`), `---
name: ${name}
description: acceptance
${name === "prepare" ? "" : "prime-ralph-invocation-version: 1\n"}---
${body}
`);
await writeFile(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# ready fixture specification\n");
await writeFile(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# ready fixture plan\n");
const auth = AuthStorage.inMemory(); auth.set("acceptance", { type: "api_key", key: "not-a-real-key" });
const registry = ModelRegistry.inMemory(auth), settings = SettingsManager.inMemory({ compaction: { enabled: false }, goals: { enabled: true, maxContinuations: 10 } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(cwd, ".prime/agent/extensions/prime-ralph/index.js"), auxiliaryExtension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "READY_BASELINE" });
await loader.reload(); if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
const sm = SessionManager.create(cwd, sessionDir), contexts = [];
const provisioner = new IpythonKernelProvisioner(cwd, { sessionId: sm.getSessionId() }), ipython = createIpythonTool(cwd, { provisioner });
let session, phase = "initial-wait", oldGoalId, replacementGoalId, negativeGoalId, fakeRlmRun, readyToolResultContinued = false;
const agent = new Agent({ initialState: { systemPrompt: "READY_BASELINE", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] }, convertToLlm,
  transformContext: async (messages) => session ? session._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => {
    const visible = text(context); contexts.push(visible); const meta = invocation(visible);
    if (!meta || meta.skill !== "execute") return response(assistant("planning interaction"));
    if (phase === "initial-wait") {
      session._startGoal("ready handoff original driver", 100); oldGoalId = session.goalState.goalId; session._completeGoalFromHost();
      phase = "wait-tool-result";
      return response(assistant([{ type: "toolCall", id: "wait", name: "ralph_lifecycle", arguments: { action: "wait", lifecycleId: meta.lifecycleId, cycle: meta.cycle, reason: "independent review", readiness: "review child replies" } }], "toolUse"));
    }
    if (phase === "wait-tool-result") { phase = "waiting"; return response(assistant("waiting for review")); }
    if (phase === "waiting") {
      session._startGoal("ready handoff replacement driver", 100); replacementGoalId = session.goalState.goalId; phase = "ready-tool-result";
      return response(assistant([{ type: "toolCall", id: "ready", name: "ralph_lifecycle", arguments: { action: "ready", lifecycleId: meta.lifecycleId, cycle: meta.cycle, waitId: latestState(sm).wait.id, readiness: "review child returned clean" } }], "toolUse"));
    }
    if (phase === "ready-tool-result") { readyToolResultContinued = true; phase = "replacement-continuation"; return response(assistant("readiness accepted without abort")); }
    if (phase === "replacement-continuation") {
      session._completeGoalFromHost(); phase = "complete-tool-result";
      return response(assistant([{ type: "toolCall", id: "complete", name: "ralph_lifecycle", arguments: { action: "complete", lifecycleId: meta.lifecycleId, cycle: meta.cycle, archive: false } }], "toolUse"));
    }
    if (phase === "complete-tool-result") { phase = "complete"; return response(assistant("execution complete")); }
    if (phase === "negative-bind") {
      session._startGoal("ready handoff negative control driver", 100); negativeGoalId = session.goalState.goalId; phase = "negative-bind-tool-result";
      return response(assistant([{ type: "toolCall", id: "negative-continue", name: "ralph_lifecycle", arguments: { action: "continue", lifecycleId: meta.lifecycleId, cycle: meta.cycle } }], "toolUse"));
    }
    if (phase === "negative-bind-tool-result") {
      fakeRlmRun = { settled: false }; session._unsettledRlmChildRuns.add(fakeRlmRun); phase = "negative-held";
      return response(assistant("negative driver bound"));
    }
    return response(assistant("unexpected extra turn"));
  }, sessionId: sm.getSessionId() });
session = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, customTools: [ipython], initialActiveToolNames: ["ipython"], allowedToolNames: ["ipython", "ralph_lifecycle"], includeGoals: true, includeCompactSkill: false });
await session.bindExtensions({}); await waitFor(() => contexts.length >= 1 && !session.isStreaming, "planning startup");
for (let turn = 1; turn <= 3; turn += 1) await session.promptAndWait(`READY_STALE_TURN_${turn}\n${"old context ".repeat(2500)}`);
await session.prompt("/execute");
await waitFor(() => latestState(sm)?.status === "waiting" && !session.isStreaming, "waiting lifecycle");
const historicalGoal = { role: "custom", customType: "goal_context", content: historicalSentinel, display: false, details: { kind: "continuation", goalId: oldGoalId, continuationsUsed: 1 }, timestamp: Date.now() };
agent.state.messages.push(historicalGoal); sm.appendMessage(historicalGoal);
await session.promptUntilAccepted(childSentinel, { streamingBehavior: "steer", customMessage: { role: "custom", customType: "agent_message", content: childSentinel, display: true, details: { id: "agentmsg_ready_acceptance", message: childSentinel, fromRelationship: "child" }, timestamp: Date.now() } });
await waitFor(() => latestState(sm)?.status === "inactive" && !session.isStreaming, "completed ready handoff lifecycle");
const positiveStates = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).map((entry) => entry.data);
const positiveLifecycleIds = new Set(positiveStates.filter((state) => state.lifecycleId).map((state) => state.lifecycleId));
const positiveCycles = new Set(positiveStates.filter((state) => state.lifecycleId).map((state) => state.cycle));
const positiveCompleted = latestState(sm)?.status === "inactive" && session.goalState.status === "complete" && phase === "complete";
phase = "padding";
for (let turn = 1; turn <= 3; turn += 1) await session.promptAndWait(`READY_NEGATIVE_PADDING_${turn}\n${"new context ".repeat(2500)}`);
const negativeStartIndex = sm.getEntries().length; phase = "negative-bind";
await session.prompt("/execute");
await waitFor(() => phase === "negative-held" && typeof latestState(sm)?.pendingDecision?.finalAssistantMessage === "string" && !session.isStreaming, "negative control driver binding");
const stalePrimary = { role: "custom", customType: "goal_context", content: "STALE_PRIMARY_GOAL_CONTEXT", display: true, details: { kind: "continuation", goalId: oldGoalId, objective: "stale", status: "active", continuationsUsed: 1 }, timestamp: Date.now() };
await session.promptUntilAccepted("STALE_PRIMARY_GOAL_CONTEXT", { streamingBehavior: "steer", customMessage: stalePrimary });
await waitFor(() => latestState(sm)?.status === "paused" && !session.isStreaming, "auxiliary custom stale-goal rejection");
const entries = sm.getEntries(), states = entries.filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).map((entry) => entry.data);
const incidentContexts = contexts.filter((value) => value.includes(historicalSentinel) && value.includes(childSentinel));
const negativeEntries = entries.slice(negativeStartIndex), entryCustomType = (entry) => entry?.customType ?? entry?.message?.customType, entryContent = (entry) => entry?.content ?? entry?.message?.content;
const staleIndex = negativeEntries.findIndex((entry) => entryCustomType(entry) === "goal_context" && entryContent(entry) === "STALE_PRIMARY_GOAL_CONTEXT");
const auxiliaryAfterStale = negativeEntries.findIndex((entry, index) => index > staleIndex && entryCustomType(entry) === "acceptance_auxiliary");
const checks = {
  primeAgentVersion: JSON.parse(await readFile(join(primeRoot, "package.json"), "utf8")).version === "0.9.3",
  exactHistoricalOrderObserved: incidentContexts.some((value) => value.indexOf(historicalSentinel) < value.indexOf(childSentinel) && value.indexOf(childSentinel) < value.lastIndexOf(auxiliarySentinel)),
  validAgentMessageIdentity: entries.some((entry) => entry?.customType === "agent_message" && entry.details?.id === "agentmsg_ready_acceptance" && entry.details?.message === childSentinel),
  replacementDriverRebound: Boolean(oldGoalId && replacementGoalId && oldGoalId !== replacementGoalId && positiveStates.some((state) => state.driverGoalId === replacementGoalId && state.pendingDecision?.action === "ready")),
  readyToolResultContinued,
  noFalsePauseOrAbort: !positiveStates.some((state) => state.status === "paused" || state.pauseReason === "stale or mismatched native goal continuation"),
  sameLifecycleAndCycle: positiveLifecycleIds.size === 1 && positiveCycles.size === 1,
  positiveCompleted,
  auxiliaryCannotHideStaleGoal: Boolean(negativeGoalId && negativeGoalId !== oldGoalId && staleIndex >= 0 && auxiliaryAfterStale > staleIndex && latestState(sm)?.pauseReason === "stale or mismatched native goal continuation"),
};
await session.disposeAsync({ kernelSnapshot: false });
const failures = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
if (failures.length) { console.error(JSON.stringify({ checks, failures, phase, stateTail: states.slice(-12), contextCount: contexts.length }, null, 2)); process.exit(1); }
console.log(JSON.stringify({ ...checks, contextCount: contexts.length }, null, 2));
