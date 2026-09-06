import { mkdtemp, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BLOCKED_MESSAGE_TYPE, EXECUTION_STATE_ENTRY_TYPE } from "../src/execution.js";
import {
  ACTIVE_EXECUTION_PLAN_PATH, ACTIVE_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH,
  BLOCKED_PROVENANCE_PATH, BLOCKED_SPECIFICATION_PATH, blockPlanningDocuments,
} from "../src/planning-transaction.js";

const primeRoot = process.env.PRIME_AGENT_ROOT, coreRoot = process.env.PRIME_AGENT_CORE_ROOT;
if (!primeRoot || !coreRoot) throw new Error("PRIME_AGENT_ROOT and PRIME_AGENT_CORE_ROOT are required");
const imp = (path) => import(pathToFileURL(join(primeRoot, "dist", path)).href);
const [{ Agent }, { AgentSession }, { SessionManager }, { SettingsManager }, { AuthStorage }, { ModelRegistry }, { DefaultResourceLoader }, { convertToLlm }] = await Promise.all([
  import(pathToFileURL(join(coreRoot, "dist/agent.js")).href), imp("core/agent-session.js"), imp("core/session-manager.js"), imp("core/settings-manager.js"), imp("core/auth-storage.js"), imp("core/model-registry.js"), imp("core/resource-loader.js"), imp("core/messages.js"),
]);
const model = { provider: "poc", id: "fake", api: "openai-completions", contextWindow: 100000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function assistant(content, stopReason = "stop") { return { role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content, api: model.api, provider: model.provider, model: model.id, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() }; }
function response(message) { return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: message.stopReason, message }; }, async result() { return message; } }; }
const invocation = (messages) => { const text = JSON.stringify(messages); const match = text.match(/<prime-ralph-invocation>(.*?)<\\\/prime-ralph-invocation>/s) ?? text.match(/<prime-ralph-invocation>(.*?)<\/prime-ralph-invocation>/s); return match ? JSON.parse(match[1].replaceAll('\\"', '"')) : null; };
const waitFor = async (predicate, label) => { const deadline = Date.now() + 12000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`); await new Promise((resolve) => setTimeout(resolve, 10)); } };

const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-blocked-recovery-")), sessionDir = join(cwd, "sessions"), agentDir = join(cwd, ".agent");
for (const dir of [".ralph/skills/prepare", ".ralph/skills/spec-it-out", ".ralph/skills/plan", ".ralph/skills/execute", ".ralph/skills/blocked", ".ralph/plans/blocked", ".ralph/plans/archive", ".prime/agent/extensions", "sessions", ".agent"]) await mkdir(join(cwd, dir), { recursive: true });
await symlink(new URL("../src", import.meta.url), join(cwd, ".prime/agent/extensions/prime-ralph"), "dir");
for (const [name, body] of Object.entries({ prepare: "RECOVERY_PREPARE", "spec-it-out": "spec", plan: "plan", execute: "RECOVERY_EXECUTE", blocked: "RECOVERY_BLOCKED" })) await writeFile(join(cwd, `.ralph/skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: acceptance\n${name === "prepare" ? "" : "prime-ralph-invocation-version: 1\n"}---\n${body}\n`);
const specification = "# blocked recovery fixture specification\n", plan = "# blocked recovery fixture plan\n";
await writeFile(join(cwd, ACTIVE_SPECIFICATION_PATH), specification); await writeFile(join(cwd, ACTIVE_EXECUTION_PLAN_PATH), plan);
blockPlanningDocuments({ cwd, lifecycleId: "blocked-life", now: () => "2026-09-05T00:00:00.000Z" });
await rename(join(cwd, BLOCKED_SPECIFICATION_PATH), join(cwd, ACTIVE_SPECIFICATION_PATH)); await rename(join(cwd, BLOCKED_EXECUTION_PLAN_PATH), join(cwd, ACTIVE_EXECUTION_PLAN_PATH));

const auth = AuthStorage.inMemory(); auth.set("poc", { type: "api_key", key: "not-a-real-key" });
const registry = ModelRegistry.inMemory(auth), settings = SettingsManager.inMemory({ compaction: { enabled: false }, goals: { enabled: true, maxContinuations: 5 } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(cwd, ".prime/agent/extensions/prime-ralph/index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "RECOVERY_BASELINE" });
await loader.reload(); if (loader.getExtensions().errors.length) throw new Error(`extension load failed: ${JSON.stringify(loader.getExtensions().errors)}`);
const sm = SessionManager.create(cwd, sessionDir), sessionId = sm.getSessionId();
sm.appendMessage({ role: "user", content: [{ type: "text", text: "STALE_PRE_RECOVERY_CONTEXT" }], timestamp: Date.now() });
sm.appendCustomEntry(EXECUTION_STATE_ENTRY_TYPE, { protocolVersion: 1, source: "prime-ralph", sessionId, transition: 3, phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "blocked-life", forwardConfirmed: false, blockedContextEstablished: true, blockedContextMode: "blocked", block: { reason: "provider login is missing", unblockCondition: "provider login is restored" } });
const contexts = []; let blockedCalls = 0, executeCalls = 0, session;
const agent = new Agent({ initialState: { systemPrompt: "RECOVERY_BASELINE", model, thinkingLevel: "off", serviceTier: "auto", messages: sm.buildSessionContext().messages, tools: [] }, convertToLlm,
  transformContext: async (messages) => session ? session._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => {
    contexts.push(structuredClone(context.messages)); const meta = invocation(context.messages);
    if (meta?.invocationMode === "blocked-restored") {
      blockedCalls += 1;
      if (blockedCalls === 1) return response(assistant([{ type: "toolCall", id: "status", name: "ralph_lifecycle", arguments: { action: "status" } }], "toolUse"));
      if (blockedCalls === 2) {
        const visibleStatus = JSON.stringify(context.messages);
        if (!visibleStatus.includes("provider login is missing") || !visibleStatus.includes("provider login is restored")) return response(assistant("I cannot safely continue because the original blocker or condition is unavailable."));
        return response(assistant([{ type: "toolCall", id: "confirm", name: "ralph_lifecycle", arguments: { action: "confirm-forward", provenanceId: meta.provenanceId } }], "toolUse"));
      }
      return response(assistant(`The restored files are verified and the blocker is resolved. Run /execute when ready.
${"recovery context ".repeat(30000)}`));
    }
    if (meta?.skill === "execute") {
      executeCalls += 1;
      if (executeCalls === 1) return response(assistant([{ type: "toolCall", id: "complete", name: "ralph_lifecycle", arguments: { action: "complete", lifecycleId: meta.lifecycleId, cycle: meta.cycle, archive: false } }], "toolUse"));
      return response(assistant("Fresh execution run completed."));
    }
    return response(assistant("unexpected interaction"));
  }, sessionId });
session = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, customTools: [], initialActiveToolNames: [], allowedToolNames: ["ralph_lifecycle"], includeGoals: true, includeCompactSkill: false });
await session.bindExtensions({});
await waitFor(() => { const state = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data; return blockedCalls >= 3 && state?.phase === "planning" && state?.forwardConfirmed === true && !session.isStreaming; }, "restored blocked interaction");
const recoveredState = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1).data;
const recoveryContexts = contexts.slice(0, 3).map((messages) => JSON.stringify(messages));
await session.prompt("/execute");
await waitFor(() => { const state = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data; return executeCalls >= 2 && state?.pendingDecision === null && state?.phase === "planning" && !session.isStreaming; }, "fresh explicit execution");
const states = sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).map((entry) => entry.data), started = states.find((state) => state.phase === "execution" && state.status === "running");
const checks = {
  primeAgentVersion: JSON.parse(await readFile(join(primeRoot, "package.json"), "utf8")).version === "0.9.1",
  restoredPromptOnce: blockedCalls === 3 && recoveryContexts.every((value) => value.includes("RECOVERY_BLOCKED")),
  staleContextExcluded: recoveryContexts.every((value) => !value.includes("STALE_PRE_RECOVERY_CONTEXT")),
  blockerAndConditionVisible: recoveryContexts[1].includes("provider login is missing") && recoveryContexts[1].includes("provider login is restored"),
  toolTailPreserved: recoveryContexts[2].includes('"name":"ralph_lifecycle"') && recoveryContexts[2].includes('"toolCallId":"confirm"'),
  activeFilesUnchanged: await readFile(join(cwd, ACTIVE_SPECIFICATION_PATH), "utf8") === specification && await readFile(join(cwd, ACTIVE_EXECUTION_PLAN_PATH), "utf8") === plan,
  markerRemoved: !existsSync(join(cwd, BLOCKED_PROVENANCE_PATH)),
  recoveryConfirmedWithoutAutomaticExecution: recoveredState.phase === "planning" && recoveredState.forwardConfirmed === true && recoveredState.recovery === null,
  explicitExecuteCreatedFreshLifecycle: Boolean(started?.lifecycleId) && started.lifecycleId !== "blocked-life" && executeCalls === 2,
  noForcedArchive: existsSync(join(cwd, ACTIVE_SPECIFICATION_PATH)) && existsSync(join(cwd, ACTIVE_EXECUTION_PLAN_PATH)),
};
await session.disposeAsync({ kernelSnapshot: false });
const failures = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
if (failures.length) { console.error(JSON.stringify({ checks, failures, blockedCalls, executeCalls, states }, null, 2)); process.exit(1); }
console.log(JSON.stringify({ ...checks, sessionId, recoveredLifecycle: recoveredState.provenanceId, freshLifecycle: started.lifecycleId }, null, 2));
