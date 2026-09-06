import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const primeRoot = process.env.PRIME_AGENT_ROOT;
const coreRoot = process.env.PRIME_AGENT_CORE_ROOT;
if (!primeRoot || !coreRoot) throw new Error("PRIME_AGENT_ROOT and PRIME_AGENT_CORE_ROOT are required");
const imp = (path) => import(pathToFileURL(join(primeRoot, "dist", path)).href);
const [{ Agent }, { AgentSession }, { SessionManager }, { SettingsManager }, { AuthStorage }, { ModelRegistry }, { DefaultResourceLoader }, { convertToLlm }, { createIpythonTool, IpythonKernelProvisioner }] = await Promise.all([
  import(pathToFileURL(join(coreRoot, "dist/agent.js")).href),
  imp("core/agent-session.js"), imp("core/session-manager.js"), imp("core/settings-manager.js"),
  imp("core/auth-storage.js"), imp("core/model-registry.js"), imp("core/resource-loader.js"),
  imp("core/messages.js"), imp("core/tools/index.js"),
]);
const stableTranscript = (messages) => JSON.stringify(messages, (key, value) => key === "timestamp" ? undefined : value);
const extensionDirectory = new URL("../src", import.meta.url);
const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-reset-"));
const sessionDir = join(cwd, "sessions");
const agentDir = join(cwd, ".agent");
await mkdir(join(cwd, ".ralph/skills/prepare"), { recursive: true });
await mkdir(join(cwd, ".prime/agent/extensions"), { recursive: true });
await mkdir(sessionDir, { recursive: true }); await mkdir(agentDir, { recursive: true });
await symlink(extensionDirectory, join(cwd, ".prime/agent/extensions/prime-ralph"), "dir");
const prepareSentinel = "PREPARE_SENTINEL_SLICE1_93f04";
const userSentinel = "USER_SENTINEL_SLICE1_02aa1";
const assistantSentinel = "ASSISTANT_SENTINEL_SLICE1_b88c2";
const toolSentinel = "TOOL_SENTINEL_SLICE1_d7713";
const replName = "REPL_SENTINEL_SLICE1";
const replValue = "REPL_ALIVE_SLICE1_5c1d9";
const skillText = `---\nname: prepare\ndescription: Slice 1 acceptance fixture\n---\n\n${prepareSentinel}\n`;
await writeFile(join(cwd, ".ralph/skills/prepare/SKILL.md"), skillText);

const auth = AuthStorage.inMemory(); auth.set("acceptance", { type: "api_key", key: "not-a-real-key" });
const registry = ModelRegistry.inMemory(auth);
const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(cwd, ".prime/agent/extensions/prime-ralph/index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "HOST_BASELINE_SENTINEL" });
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error(`extension load failed: ${JSON.stringify(loader.getExtensions().errors)}`);
const sm = SessionManager.create(cwd, sessionDir);
const sessionId = sm.getSessionId();
const provisioner = new IpythonKernelProvisioner(cwd, { sessionId });
const ipython = createIpythonTool(cwd, { provisioner });
const model = { provider: "acceptance", id: "fake", api: "openai-completions", contextWindow: 100000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const contexts = [], transcriptMatches = [];
let call = 0;
function assistant(content, stopReason = "stop") {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() };
}
function response(message) { return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: message.stopReason, message }; }, async result() { return message; } }; }
const responses = [
  () => assistant([{ type: "text", text: assistantSentinel }, { type: "toolCall", id: "set-sentinel", name: "ipython", arguments: { code: `${replName} = ${JSON.stringify(replValue)}\nprint(${JSON.stringify(toolSentinel)})` } }], "toolUse"),
  () => assistant([{ type: "text", text: "initial turn complete" }]),
  () => assistant([{ type: "text", text: "old turn one complete" }]),
  () => assistant([{ type: "text", text: "old turn two complete" }]),
  () => assistant([{ type: "text", text: "old turn three complete" }]),
  () => assistant([{ type: "toolCall", id: "read-sentinel", name: "ipython", arguments: { code: `print(${replName})` } }], "toolUse"),
  () => assistant([{ type: "text", text: "reset turn complete" }]),
];
let hostSession;
const agent = new Agent({
  initialState: { systemPrompt: "HOST_BASELINE_SENTINEL", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [ipython] },
  convertToLlm,
  transformContext: async (messages) => hostSession ? hostSession._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => { contexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) }); transcriptMatches.push(stableTranscript(context.messages) === stableTranscript(convertToLlm(sm.buildSessionContext().messages))); const fn = responses[call++]; if (!fn) throw new Error(`unexpected provider call ${call}`); return response(fn()); },
  sessionId,
});
const session = hostSession = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, customTools: [], initialActiveToolNames: ["ipython"], allowedToolNames: ["ipython"], includeGoals: false, includeCompactSkill: false });
await session.promptAndWait(userSentinel);
for (let turn = 1; turn <= 3; turn += 1) await session.promptAndWait(`OLD_TURN_${turn}\n${"old context ".repeat(2500)}`);
const sessionFile = session.sessionFile;
const beforeResetEntries = sm.getEntries().length;
const identityBefore = { sessionId: session.sessionId, sessionFile };

async function runReset() {
  const targetCalls = call + 1;
  await session.prompt("/reset");
  while (call < targetCalls || session.isStreaming) await new Promise((resolve) => setTimeout(resolve, 10));
  await session.waitForIdle();
}
await runReset();
const identityAfter = { sessionId: session.sessionId, sessionFile: session.sessionFile };
const callsBeforeRefusedReset = call;
await session.prompt("/reset");
const refusalDeadline = Date.now() + 10000;
while (!sm.getEntries().some((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_state" && entry.data?.status === "failed" && entry.data?.reason === "compaction_unavailable")) {
  if (Date.now() > refusalDeadline) throw new Error("timeout waiting for refused short reset");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await session.waitForIdle();
const identityFinal = { sessionId: session.sessionId, sessionFile: session.sessionFile };
const entries = sm.getEntries();
const jsonl = await readFile(sessionFile, "utf8");
const resetContexts = [contexts[5]];
const firstResetText = JSON.stringify(contexts[5]);
const continuationText = JSON.stringify(contexts[6]);
const result = {
  primeAgentVersion: JSON.parse(await readFile(join(primeRoot, "package.json"), "utf8")).version,
  cwd, providerCalls: call, identityBefore, identityAfter, identityFinal,
  providerTranscriptEquivalent: transcriptMatches.length === contexts.length && transcriptMatches.every(Boolean),
  beforeResetEntries, afterResetEntries: entries.length,
  prepareCounts: resetContexts.map((context) => JSON.stringify(context).split(prepareSentinel).length - 1),
  nativeResetRoles: resetContexts.map((context) => context.messages.map((message) => message.role)),
  firstResetRoles: contexts[2].messages.map((message) => message.role),
  secondResetRoles: contexts[4].messages.map((message) => message.role),
  replSurvived: continuationText.includes(replValue),
  staleExcluded: ![userSentinel, assistantSentinel, toolSentinel].some((sentinel) => firstResetText.includes(sentinel) || continuationText.includes(sentinel)),
  baselinePreserved: contexts[2].systemPrompt === contexts[0].systemPrompt,
  jsonlRetained: [userSentinel, assistantSentinel, toolSentinel].every((sentinel) => jsonl.includes(sentinel)),
  resetMessages: entries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare").length,
  resetModes: entries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare").map((entry) => entry.details?.mode),
  resetCompactions: entries.filter((entry) => entry.type === "compaction" && entry.customInstructions?.startsWith("prime-ralph-reset:v3:")).length,
  refusedResetPreservedProviderCount: call === callsBeforeRefusedReset,
  refusedResetState: entries.filter((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_state").at(-1)?.data?.reason,
  goalsOrPhases: entries.filter((entry) => /goal|phase|execute|blocked/.test(entry.customType ?? "")).length,
};
const failures = [];
if (result.primeAgentVersion !== "0.9.1") failures.push("wrong Prime Agent version");
if (JSON.stringify(identityBefore) !== JSON.stringify(identityAfter) || JSON.stringify(identityBefore) !== JSON.stringify(identityFinal)) failures.push("session identity changed");
if (result.providerCalls !== 7) failures.push("unexpected provider call count");
if (!result.providerTranscriptEquivalent) failures.push("provider context diverged from the native session transcript");
if (!result.prepareCounts.every((count) => count === 1)) failures.push("prepare not injected exactly once per reset");
if (!result.replSurvived) failures.push("REPL sentinel did not survive");
if (!result.staleExcluded) failures.push("stale sentinel reached reset context");
if (!result.baselinePreserved) failures.push("host baseline changed");
if (!result.jsonlRetained || result.afterResetEntries <= result.beforeResetEntries) failures.push("JSONL history not retained");
if (result.resetMessages !== 1) failures.push("refused short reset produced a boundary");
if (result.resetCompactions !== 1 || JSON.stringify(result.resetModes) !== JSON.stringify(["compaction"])) failures.push("successful reset did not use exactly one real compaction");
if (!result.refusedResetPreservedProviderCount || result.refusedResetState !== "compaction_unavailable") failures.push("short reset changed provider context instead of reporting refusal");
if (result.goalsOrPhases !== 0) failures.push("goal or phase state was introduced");
await session.disposeAsync({ kernelSnapshot: false });
await provisioner.kill();
if (failures.length) { console.error(JSON.stringify({ ...result, failures }, null, 2)); process.exit(1); }
console.log(JSON.stringify(result, null, 2));
process.exit(0);
