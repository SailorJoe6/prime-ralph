import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXECUTION_STATE_ENTRY_TYPE } from "../src/execution.js";
import { RESET_STATE_TYPE } from "../src/reset-context.js";

const primeRoot = process.env.PRIME_AGENT_ROOT, coreRoot = process.env.PRIME_AGENT_CORE_ROOT;
if (!primeRoot || !coreRoot) throw new Error("PRIME_AGENT_ROOT and PRIME_AGENT_CORE_ROOT are required");
const imp = (path) => import(pathToFileURL(join(primeRoot, "dist", path)).href);
const [{ Agent }, { AgentSession }, { SessionManager }, { SettingsManager }, { AuthStorage }, { ModelRegistry }, { DefaultResourceLoader }, { convertToLlm }, { createIpythonTool, IpythonKernelProvisioner }] = await Promise.all([
  import(pathToFileURL(join(coreRoot, "dist/agent.js")).href), imp("core/agent-session.js"), imp("core/session-manager.js"), imp("core/settings-manager.js"), imp("core/auth-storage.js"), imp("core/model-registry.js"), imp("core/resource-loader.js"), imp("core/messages.js"), imp("core/tools/index.js"),
]);
const model = { provider: "poc", id: "fake", api: "openai-completions", contextWindow: 120000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content, api: model.api, provider: model.provider, model: model.id, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() });
const response = (message) => ({ async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: message.stopReason, message }; }, async result() { return message; } });
const visibleText = (context) => context.messages.map((message) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => part?.text ?? "").join("\n") : "").join("\n");
const invocation = (value) => { const match = value.match(/<prime-ralph-invocation>(.*?)<\/prime-ralph-invocation>/s); return match ? JSON.parse(match[1]) : null; };
const waitFor = async (predicate, label) => { const deadline = Date.now() + 20000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`); await new Promise((resolve) => setTimeout(resolve, 10)); } };

const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-admission-failure-acceptance-")), sessionDir = join(cwd, "sessions"), agentDir = join(cwd, ".agent"), injector = join(cwd, "inject-admission-failure.mjs");
for (const dir of [".ralph/skills/prepare", ".ralph/skills/spec-it-out", ".ralph/skills/plan", ".ralph/skills/execute", ".ralph/skills/blocked", ".ralph/plans/blocked", ".ralph/plans/archive", ".prime/agent/extensions", "sessions", ".agent"]) await mkdir(join(cwd, dir), { recursive: true });
await symlink(new URL("../src", import.meta.url), join(cwd, ".prime/agent/extensions/prime-ralph"), "dir");
await writeFile(injector, `export default function inject(pi) {
  pi.on("message_start", (event, ctx) => {
    if (event.message?.customType !== "prime_ralph_reset_prepare" || event.message?.details?.command !== "execute-round" || ctx.sessionManager.__primeRalphFailureInjected) return;
    ctx.sessionManager.__primeRalphFailureInjected = true;
    const original = ctx.sessionManager.appendCustomEntry.bind(ctx.sessionManager);
    let remainingFailures = 2;
    ctx.sessionManager.appendCustomEntry = (type, data) => { if (type === "prime_ralph_execution_state" && remainingFailures-- > 0) throw new Error("injected recovering execution-state append failure"); return original(type, data); };
  });
}
`);
for (const [name, body] of Object.entries({ prepare: "FAIL_PREPARE", "spec-it-out": "spec", plan: "plan", execute: "FAIL_EXECUTE", blocked: "blocked" })) await writeFile(join(cwd, `.ralph/skills/${name}/SKILL.md`), `---
name: ${name}
description: acceptance
${name === "prepare" ? "" : "prime-ralph-invocation-version: 1\n"}---
${body}
`);
await writeFile(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# failure fixture specification\n");
await writeFile(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# failure fixture plan\n");
const auth = AuthStorage.inMemory(); auth.set("poc", { type: "api_key", key: "not-a-real-key" });
const registry = ModelRegistry.inMemory(auth), settings = SettingsManager.inMemory({ compaction: { enabled: false }, goals: { enabled: true, maxContinuations: 10 } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [injector, join(cwd, ".prime/agent/extensions/prime-ralph/index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "FAIL_BASELINE" });
await loader.reload(); if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
const sm = SessionManager.create(cwd, sessionDir), contexts = [], stages = new Map();
const provisioner = new IpythonKernelProvisioner(cwd, { sessionId: sm.getSessionId() }), ipython = createIpythonTool(cwd, { provisioner });
let session;
const agent = new Agent({ initialState: { systemPrompt: "FAIL_BASELINE", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] }, convertToLlm,
  transformContext: async (messages) => session ? session._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => {
    const visible = visibleText(context); contexts.push(visible); const meta = invocation(visible);
    if (!meta || meta.skill !== "execute") return response(assistant("planning interaction"));
    const stage = stages.get(meta.cycle) ?? 0; stages.set(meta.cycle, stage + 1);
    if (meta.cycle === 1 && stage === 0) {
      if (session.goalState.status !== "active") session._startGoal("Admission failure acceptance goal", 100);
      return response(assistant([{ type: "toolCall", id: "continue", name: "ralph_lifecycle", arguments: { action: "continue", lifecycleId: meta.lifecycleId, cycle: 1 } }], "toolUse"));
    }
    if (meta.cycle === 1) return response(assistant(`cycle one complete ${"context ".repeat(30000)}`));
    return response(assistant("FORBIDDEN_NEXT_ROUND_PROVIDER_REQUEST"));
  }, sessionId: sm.getSessionId() });
session = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, customTools: [ipython], initialActiveToolNames: ["ipython"], allowedToolNames: ["ipython", "ralph_lifecycle"], includeGoals: true, includeCompactSkill: false });
await session.bindExtensions({}); await waitFor(() => contexts.length >= 1 && !session.isStreaming, "planning startup");
for (let turn = 1; turn <= 3; turn += 1) await session.promptAndWait(`OLD_FAILURE_CONTEXT_${turn}\n${"old context ".repeat(2500)}`);
await session.prompt("/execute");
await waitFor(() => sm.getEntries().some((entry) => entry.customType === RESET_STATE_TYPE && entry.data?.reason === "skill_admission_commit_failed") && !session.isStreaming, "fail-closed admission");
await session.prompt("RECOVERED_STORAGE_PROVIDER_PROBE");
await waitFor(() => sm.getEntries().filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).at(-1)?.data?.pendingRound?.stage === "failed" && !session.isStreaming, "recovered storage remains fail-closed");
const entries = sm.getEntries(), states = entries.filter((entry) => entry.customType === EXECUTION_STATE_ENTRY_TYPE).map((entry) => entry.data), metas = contexts.map(invocation).filter(Boolean);
const checks = {
  primeAgentVersion: JSON.parse(await readFile(join(primeRoot, "package.json"), "utf8")).version === "0.9.1",
  compactionCompleted: entries.some((entry) => entry.type === "compaction" && entry.details?.command === "execute-round"),
  admissionFailureDurable: entries.some((entry) => entry.customType === RESET_STATE_TYPE && entry.data?.reason === "skill_admission_commit_failed"),
  providerDenied: !metas.some((meta) => meta.cycle === 2) && !contexts.some((value) => value.includes("FORBIDDEN_NEXT_ROUND_PROVIDER_REQUEST")),
  cycleNotAdvanced: states.at(-1)?.cycle === 1 && states.at(-1)?.pendingRound?.stage === "failed" && states.at(-1)?.status === "paused",
  recoveredProbeDenied: !contexts.some((value) => value.includes("RECOVERED_STORAGE_PROVIDER_PROBE")),
};
await session.disposeAsync({ kernelSnapshot: false });
const failures = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
if (failures.length) { console.error(JSON.stringify({ checks, failures, stages: Object.fromEntries(stages), states: states.slice(-6) }, null, 2)); process.exit(1); }
console.log(JSON.stringify(checks, null, 2));
