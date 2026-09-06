import { existsSync } from "node:fs";
import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const primeRoot = process.env.PRIME_AGENT_ROOT;
const coreRoot = process.env.PRIME_AGENT_CORE_ROOT;
if (!primeRoot || !coreRoot) throw new Error("PRIME_AGENT_ROOT and PRIME_AGENT_CORE_ROOT are required");
const imp = (path) => import(pathToFileURL(join(primeRoot, "dist", path)).href);
const [{ Agent }, { AgentSession }, { SessionManager }, { SettingsManager }, { AuthStorage }, { ModelRegistry }, { DefaultResourceLoader }, { convertToLlm }] = await Promise.all([
  import(pathToFileURL(join(coreRoot, "dist/agent.js")).href),
  imp("core/agent-session.js"), imp("core/session-manager.js"), imp("core/settings-manager.js"),
  imp("core/auth-storage.js"), imp("core/model-registry.js"), imp("core/resource-loader.js"), imp("core/messages.js"),
]);
const stableTranscript = (messages) => JSON.stringify(messages, (key, value) => key === "timestamp" ? undefined : value);
const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-specification-acceptance-"));
const sessionDir = join(cwd, "sessions"), agentDir = join(cwd, ".agent");
await mkdir(join(cwd, ".ralph/skills/prepare"), { recursive: true });
await mkdir(join(cwd, ".ralph/skills/spec-it-out"), { recursive: true });
await mkdir(join(cwd, ".ralph/plans"), { recursive: true });
await mkdir(join(cwd, ".prime/agent/extensions"), { recursive: true });
await mkdir(sessionDir, { recursive: true }); await mkdir(agentDir, { recursive: true });
await symlink(new URL("../src", import.meta.url), join(cwd, ".prime/agent/extensions/prime-ralph"), "dir");
const prepareSentinel = "PREPARE_SENTINEL_SLICE3_814c";
const skillSentinel = "SPEC_SKILL_SENTINEL_SLICE3_78b1";
const userSentinel = "USER_CONVERSATION_SENTINEL_SLICE3_1af9";
const laterSentinel = "LATER_CONVERSATION_SENTINEL_SLICE3_5ca0";
await writeFile(join(cwd, ".ralph/skills/prepare/SKILL.md"), `---
name: prepare
description: test
---
${prepareSentinel}
`);
await writeFile(join(cwd, ".ralph/skills/spec-it-out/SKILL.md"), `---
name: spec-it-out
description: test
prime-ralph-invocation-version: 1
---
${skillSentinel}
`);
const auth = AuthStorage.inMemory(); auth.set("acceptance", { type: "api_key", key: "not-a-real-key" });
const registry = ModelRegistry.inMemory(auth);
const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(cwd, ".prime/agent/extensions/prime-ralph/index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "SLICE3_BASELINE" });
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error(`extension load failed: ${JSON.stringify(loader.getExtensions().errors)}`);
const sm = SessionManager.create(cwd, sessionDir), sessionId = sm.getSessionId();
const model = { provider: "acceptance", id: "fake", api: "openai-completions", contextWindow: 100000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const contexts = [], transcriptMatches = [];
function assistant(text) { return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() }; }
function response(message) { return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: "stop", message }; }, async result() { return message; } }; }
let hostSession;
const agent = new Agent({
  initialState: { systemPrompt: "SLICE3_BASELINE", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] },
  convertToLlm,
  transformContext: async (messages) => hostSession ? hostSession._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => { contexts.push(structuredClone(context)); transcriptMatches.push(stableTranscript(context.messages) === stableTranscript(convertToLlm(sm.buildSessionContext().messages))); return response(assistant(`provider-call-${contexts.length}`)); },
  sessionId,
  providerTranscriptEquivalent: transcriptMatches.length === contexts.length && transcriptMatches.every(Boolean),
});
const session = hostSession = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, customTools: [], initialActiveToolNames: [], allowedToolNames: [], includeGoals: false, includeCompactSkill: false });
await session.bindExtensions({});
const waitFor = async (predicate, label) => { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`); await new Promise((resolve) => setTimeout(resolve, 10)); } };
await waitFor(() => sm.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_startup_prepare"), "durable startup prepare");
await waitFor(() => contexts.length >= 1 && !session.isStreaming, "startup turn");
const callsAfterStartup = contexts.length;
await session.reload(); await new Promise((resolve) => setTimeout(resolve, 50)); await session.waitForIdle();
const callsAfterReload = contexts.length;
await session.promptAndWait(userSentinel);
const beforeNewCommand = contexts.length; await session.prompt("/spec-it-out");
await waitFor(() => contexts.length > beforeNewCommand && !session.isStreaming, "new specification command");
const newCommandContext = contexts.at(-1);
const newHandlerDidNotWrite = !existsSync(join(cwd, ".ralph/plans/SPECIFICATION.md"));
await writeFile(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# Existing fixture specification\n");
await session.promptAndWait(laterSentinel);
const beforeExistingCommand = contexts.length; await session.prompt("/spec-it-out");
await waitFor(() => contexts.length > beforeExistingCommand && !session.isStreaming, "existing specification command");
const existingCommandContext = contexts.at(-1);
const existingAfterCommand = await readFile(join(cwd, ".ralph/plans/SPECIFICATION.md"), "utf8");
for (let turn = 0; turn < 4; turn += 1) await session.promptAndWait(`SPEC_RESET_PADDING_${turn} ${"old context ".repeat(2500)}`);
const beforeReset = contexts.length; await session.prompt("/reset");
await waitFor(() => contexts.length > beforeReset && !session.isStreaming, "specification reset");
const resetContext = contexts.at(-1);
const entries = sm.getEntries();
const text = (context) => context.messages.map((message) => typeof message.content === "string"
  ? message.content
  : Array.isArray(message.content) ? message.content.map((part) => part?.text ?? "").join("") : "").join("\n");
const result = {
  primeAgentVersion: JSON.parse(await readFile(join(primeRoot, "package.json"), "utf8")).version,
  sessionId,
  providerTranscriptEquivalent: transcriptMatches.length === contexts.length && transcriptMatches.every(Boolean),
  callsAfterStartup,
  callsAfterReload,
  startupMessages: entries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_startup_prepare").length,
  startupSessionIds: entries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_startup_prepare").map((entry) => entry.details?.sessionId),
  startupWasFirstTurn: contexts[0].messages.length === 1 && text(contexts[0]).includes(prepareSentinel) && !text(contexts[0]).includes(userSentinel),
  newPreservedConversation: text(newCommandContext).includes(userSentinel),
  newModeDelivered: text(newCommandContext).includes('"invocationMode":"specification-new"') && text(newCommandContext).includes(skillSentinel),
  commandHandlersDidNotWrite: newHandlerDidNotWrite && existingAfterCommand === "# Existing fixture specification\n",
  existingPreservedConversation: [userSentinel, laterSentinel].every((sentinel) => text(existingCommandContext).includes(sentinel)),
  existingModeDelivered: text(existingCommandContext).includes('"invocationMode":"specification-existing"'),
  resetPrepareFirst: text(resetContext).indexOf(prepareSentinel) < text(resetContext).indexOf('"invocationMode":"specification-reset-existing"'),
  resetExistingModeDelivered: text(resetContext).includes('"invocationMode":"specification-reset-existing"') && text(resetContext).includes(skillSentinel),
  resetExcludedStaleConversation: ![userSentinel, laterSentinel].some((sentinel) => text(resetContext).includes(sentinel)),
  resetProviderMessageCount: resetContext.messages.length,
  planExists: existsSync(join(cwd, ".ralph/plans/EXECUTION_PLAN.md")),
  registeredCommands: [...loader.getExtensions().extensions[0].commands.keys()].filter((name) => ["reset", "spec-it-out", "plan", "execute"].includes(name)),
  executionEntries: entries.filter((entry) => /execute|goal|blocked/.test(entry.customType ?? "")).length,
};
const failures = [];
if (result.primeAgentVersion !== "0.9.1") failures.push("wrong Prime Agent version");
if (!result.providerTranscriptEquivalent) failures.push("provider context diverged from the native session transcript");
if (result.callsAfterStartup !== 1 || result.callsAfterReload !== 1) failures.push("startup/reload call count incorrect");
if (result.startupMessages !== 1 || result.startupSessionIds[0] !== sessionId || !result.startupWasFirstTurn) failures.push("startup prepare was not exactly-once and first");
if (!result.newPreservedConversation || !result.newModeDelivered) failures.push("new-spec command lost context or metadata");
if (!result.commandHandlersDidNotWrite) failures.push("specification command handler mutated planning documents");
if (!result.existingPreservedConversation || !result.existingModeDelivered) failures.push("existing-spec command lost context or metadata");
if (!result.resetPrepareFirst || !result.resetExistingModeDelivered || !result.resetExcludedStaleConversation ) failures.push("specification reset boundary incorrect");
if (result.planExists || result.executionEntries !== 0 || !result.registeredCommands.includes("plan") || !result.registeredCommands.includes("execute")) failures.push("specification acceptance changed planning documents or execution state");
await session.disposeAsync({ kernelSnapshot: false });
if (failures.length) { console.error(JSON.stringify({ ...result, failures }, null, 2)); process.exit(1); }
console.log(JSON.stringify(result, null, 2));
