import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const primeRoot = process.env.PRIME_AGENT_ROOT, coreRoot = process.env.PRIME_AGENT_CORE_ROOT;
if (!primeRoot || !coreRoot) throw new Error("PRIME_AGENT_ROOT and PRIME_AGENT_CORE_ROOT are required");
const imp = (path) => import(pathToFileURL(join(primeRoot, "dist", path)).href);
const [{ Agent }, { AgentSession }, { SessionManager }, { SettingsManager }, { AuthStorage }, { ModelRegistry }, { DefaultResourceLoader }, { convertToLlm }] = await Promise.all([
  import(pathToFileURL(join(coreRoot, "dist/agent.js")).href), imp("core/agent-session.js"), imp("core/session-manager.js"), imp("core/settings-manager.js"), imp("core/auth-storage.js"), imp("core/model-registry.js"), imp("core/resource-loader.js"), imp("core/messages.js"),
]);
const stableTranscript = (messages) => JSON.stringify(messages, (key, value) => key === "timestamp" ? undefined : value);
const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-reset-busy-")), sessionDir = join(cwd, "sessions"), agentDir = join(cwd, ".agent");
await mkdir(join(cwd, ".ralph/skills/prepare"), { recursive: true }); await mkdir(join(cwd, ".prime/agent/extensions"), { recursive: true }); await mkdir(sessionDir); await mkdir(agentDir);
const prepare = "BUSY_PREPARE_SENTINEL_61cc", busySentinel = "BUSY_PRIOR_SENTINEL_e710", queuedSentinel = "QUEUED_PRIOR_SENTINEL_104a";
const busy = `${busySentinel} ${"old context ".repeat(5000)}`, queued = `${queuedSentinel} ${"queued context ".repeat(5000)}`;
await writeFile(join(cwd, ".ralph/skills/prepare/SKILL.md"), `---\nname: prepare\ndescription: Busy reset acceptance fixture\n---\n${prepare}\n`);
const auth = AuthStorage.inMemory(); auth.set("acceptance", { type: "api_key", key: "none" }); const registry = ModelRegistry.inMemory(auth); const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [new URL("../src/reset-extension.js", import.meta.url).pathname], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "baseline" }); await loader.reload();
if (loader.getExtensions().errors.length) throw new Error(`extension load failed: ${JSON.stringify(loader.getExtensions().errors)}`);
const sm = SessionManager.create(cwd, sessionDir); const model = { provider: "acceptance", id: "fake", api: "openai-completions", contextWindow: 100000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const transcriptMatches = []; let releaseFirst; const firstRelease = new Promise((resolve) => { releaseFirst = resolve; }); let firstStarted; const firstStart = new Promise((resolve) => { firstStarted = resolve; }); let calls = 0; const contexts = [];
const message = (text) => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() });
const response = (msg, gate) => ({ async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...msg, content: [] } }; if (gate) await gate; yield { type: "done", reason: "stop", message: msg }; }, async result() { if (gate) await gate; return msg; } });
let session;
const agent = new Agent({ initialState: { systemPrompt: "baseline", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] }, convertToLlm,
  transformContext: async (messages) => session?._extensionRunner.emitContext(messages) ?? messages,
  streamFn: async (_model, context) => { const index = calls++; contexts.push({ messages: structuredClone(context.messages) }); transcriptMatches.push(stableTranscript(context.messages) === stableTranscript(convertToLlm(sm.buildSessionContext().messages))); if (index === 3) { firstStarted(); return response(message("busy complete"), firstRelease); } return response(message(index === 4 ? "queued complete" : index === 5 ? "reset complete" : `history-${index}`)); },
  sessionId: sm.getSessionId(),
});
// Remove compatibility typo before constructing.
agent.state.tools = [];
session = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, initialActiveToolNames: [], allowedToolNames: [], includeGoals: false, includeCompactSkill: false });
await session.bindExtensions({});
for (let turn = 0; turn < 3; turn += 1) await session.promptAndWait(`BUSY_HISTORY_${turn} ${"prior context ".repeat(1500)}`);
void session.prompt(busy); await firstStart;
await session.followUp(queued, undefined, { resumeIfIdle: true });
await session._executeExtensionCommand("/reset"); await session._executeExtensionCommand("/reset");
if (calls !== 4) throw new Error("reset ran before active work settled");
releaseFirst(); await session.waitForIdle();
while (calls < 6 || session.isStreaming) await new Promise((resolve) => setTimeout(resolve, 5));
await session._agentEventQueue; await session.waitForIdle();
const resetText = JSON.stringify(contexts[5]); const entries = sm.getEntries();
const result = { calls, providerTranscriptEquivalent: transcriptMatches.length === contexts.length && transcriptMatches.every(Boolean), resetPrepareCount: resetText.split(prepare).length - 1, staleExcluded: !resetText.includes(busySentinel) && !resetText.includes(queuedSentinel), resetBoundaries: entries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare").length, completedStates: entries.filter((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_state" && entry.data?.status === "completed").length, resetModes: entries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare").map((entry) => entry.details?.mode), resetCompactions: entries.filter((entry) => entry.type === "compaction" && entry.customInstructions?.startsWith("prime-ralph-reset:v2:")).length };
await session.disposeAsync({ kernelSnapshot: false });
if (calls !== 6 || !result.providerTranscriptEquivalent || result.resetPrepareCount !== 1 || !result.staleExcluded || result.resetBoundaries !== 1 || result.completedStates !== 1 || JSON.stringify(result.resetModes) !== JSON.stringify(["compaction"]) || result.resetCompactions !== 1) { console.error(JSON.stringify(result, null, 2)); process.exit(1); }
console.log(JSON.stringify(result, null, 2)); process.exit(0);
