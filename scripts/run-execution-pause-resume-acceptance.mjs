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
const invocation = (value) => { const match = value.match(/<prime-ralph-invocation>(.*?)<\/prime-ralph-invocation>/s); return match ? JSON.parse(match[1]) : null; };
const waitFor = async (predicate, label) => { const deadline = Date.now() + 15000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`); await new Promise((resolve) => setTimeout(resolve, 10)); } };

const stableTranscript = (messages) => JSON.stringify(messages, (key, value) => key === "timestamp" ? undefined : value);
const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-pause-resume-acceptance-")), sessionDir = join(cwd, "sessions"), agentDir = join(cwd, ".agent");
for (const dir of [".ralph/skills/prepare", ".ralph/skills/spec-it-out", ".ralph/skills/plan", ".ralph/skills/execute", ".ralph/skills/blocked", ".ralph/plans/blocked", ".ralph/plans/archive", ".prime/agent/extensions", "sessions", ".agent"]) await mkdir(join(cwd, dir), { recursive: true });
await symlink(new URL("../src", import.meta.url), join(cwd, ".prime/agent/extensions/prime-ralph"), "dir");
for (const [name, body] of Object.entries({ prepare: "PAUSE_PREPARE", "spec-it-out": "spec", plan: "plan", execute: "PAUSE_EXECUTE", blocked: "blocked" })) await writeFile(join(cwd, `.ralph/skills/${name}/SKILL.md`), `---
name: ${name}
description: acceptance
${name === "prepare" ? "" : "prime-ralph-invocation-version: 1\n"}---
${body}
`);
await writeFile(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# pause fixture specification\n");
await writeFile(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# pause fixture plan\n");
const auth = AuthStorage.inMemory(); auth.set("acceptance", { type: "api_key", key: "not-a-real-key" });
const registry = ModelRegistry.inMemory(auth), settings = SettingsManager.inMemory({ compaction: { enabled: false }, goals: { enabled: true, maxContinuations: 10 } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(cwd, ".prime/agent/extensions/prime-ralph/index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "PAUSE_BASELINE" });
await loader.reload(); if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
const sm = SessionManager.create(cwd, sessionDir), contexts = [], transcriptMatches = [], stages = new Map();
const provisioner = new IpythonKernelProvisioner(cwd, { sessionId: sm.getSessionId() }), ipython = createIpythonTool(cwd, { provisioner });
const feedback = "NATIVE_PAUSE_FEEDBACK", acknowledgement = "NATIVE_PAUSE_ACKNOWLEDGEMENT";
let session, pauseStarted = false, counterBeforeResume, counterAfterResume, resumePromise;
const agent = new Agent({ initialState: { systemPrompt: "PAUSE_BASELINE", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] }, convertToLlm,
  transformContext: async (messages) => session ? session._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => {
    const visible = text(context); contexts.push(visible);
    transcriptMatches.push(stableTranscript(context.messages) === stableTranscript(convertToLlm(sm.buildSessionContext().messages)));
    const meta = invocation(visible);
    if (!meta || meta.skill !== "execute") return response(assistant("planning interaction"));
    const stage = stages.get(meta.cycle) ?? 0; stages.set(meta.cycle, stage + 1);
    if (meta.cycle === 1 && stage === 0) {
      if (session.goalState.status !== "active") session._startGoal("Pause/resume acceptance goal", 100);
      return response(assistant([{ type: "toolCall", id: "continue", name: "ralph_lifecycle", arguments: { action: "continue", lifecycleId: meta.lifecycleId, cycle: 1 } }], "toolUse"));
    }
    if (meta.cycle === 1) return response(assistant(`cycle one complete ${"context ".repeat(30000)}`));
    if (meta.cycle === 2 && !pauseStarted) {
      pauseStarted = true; counterBeforeResume = session.goalState.continuationsUsed;
      session._pauseGoal("native acceptance pause");
      const feedbackMessage = { role: "user", content: [{ type: "text", text: feedback }], timestamp: Date.now() };
      const acknowledgementMessage = assistant(acknowledgement);
      agent.state.messages.push(feedbackMessage, acknowledgementMessage);
      sm.appendMessage(feedbackMessage); sm.appendMessage(acknowledgementMessage);
      setImmediate(async () => {
        while (session.isStreaming) await new Promise((resolve) => setTimeout(resolve, 5));
        resumePromise = session._resumeGoal(); counterAfterResume = session.goalState.continuationsUsed;
        await resumePromise; session.resumeQueuedWork();
      });
      return response(assistant("paused current iteration", "aborted"));
    }
    if (meta.cycle === 2 && stage === 1) {
      session._completeGoalFromHost();
      return response(assistant([{ type: "toolCall", id: "complete", name: "ralph_lifecycle", arguments: { action: "complete", lifecycleId: meta.lifecycleId, cycle: 2, archive: false } }], "toolUse"));
    }
    return response(assistant("current iteration complete"));
  }, sessionId: sm.getSessionId() });
session = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, customTools: [ipython], initialActiveToolNames: ["ipython"], allowedToolNames: ["ipython", "ralph_lifecycle"], includeGoals: true, includeCompactSkill: false });
await session.bindExtensions({}); await waitFor(() => contexts.length >= 1 && !session.isStreaming, "planning startup");
for (let turn = 1; turn <= 3; turn += 1) await session.promptAndWait(`OLD_PAUSE_CONTEXT_${turn}
${"old context ".repeat(2500)}`);
await session.prompt("/execute");
await waitFor(() => contexts.some((value) => value.includes(feedback) && value.includes(acknowledgement)), "resumed provider context with feedback");
await waitFor(() => sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data?.status === "inactive" && !session.isStreaming, "completed pause/resume lifecycle");
await resumePromise;
const entries = sm.getEntries(), states = entries.filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).map((entry) => entry.data);
const metas = contexts.map(invocation).filter((meta) => meta?.skill === "execute"), resumeContexts = contexts.filter((value) => value.includes(feedback) || value.includes(acknowledgement));
const autoCompactions = entries.filter((entry) => entry.type === "compaction" && entry.details?.command === "execute-round");
const workflowSource = await readFile(new URL("../src/workflow-extension.js", import.meta.url), "utf8"), executionSource = await readFile(new URL("../src/execution.js", import.meta.url), "utf8");
const checks = {
  primeAgentVersion: JSON.parse(await readFile(join(primeRoot, "package.json"), "utf8")).version === "0.9.1",
  providerTranscriptEquivalent: transcriptMatches.length === contexts.length && transcriptMatches.every(Boolean),
  sameLifecycleAndTwoCycles: new Set(metas.map((meta) => meta.lifecycleId)).size === 1 && [1, 2].every((cycle) => metas.some((meta) => meta.cycle === cycle)),
  pauseResumeCounterUnchanged: counterBeforeResume === counterAfterResume,
  fullCurrentIterationPreserved: resumeContexts.some((value) => value.includes(feedback) && value.includes(acknowledgement) && value.includes("PAUSE_EXECUTE")),
  noResumeResetOrReinjection: autoCompactions.length === 1 && resumeContexts.every((value) => (value.match(/PAUSE_EXECUTE/g) ?? []).length === 1),
  resumedWithoutContextRewrite: !workflowSource.includes("executionContextProjection") && !executionSource.includes("executionContextProjection") && states.some((state) => state.cycle === 2 && state.status === "running" && state.resumed === false),
  completed: states.at(-1)?.status === "inactive" && session.goalState.status === "complete",
};
await session.disposeAsync({ kernelSnapshot: false });
const failures = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
if (failures.length) { console.error(JSON.stringify({ checks, failures, stages: Object.fromEntries(stages), contextCount: contexts.length, states: states.slice(-8) }, null, 2)); process.exit(1); }
console.log(JSON.stringify({ ...checks, contextCount: contexts.length }, null, 2));
