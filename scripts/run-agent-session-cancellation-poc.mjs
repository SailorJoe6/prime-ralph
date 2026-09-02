import { pathToFileURL } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const primeRoot = process.env.PRIME_AGENT_SOURCE_ROOT;
if (!primeRoot) throw new Error("PRIME_AGENT_SOURCE_ROOT required");
const imp = (p) => import(pathToFileURL(join(primeRoot, "dist", p)).href);
const [{ Agent }, { AgentSession }, { SessionManager }, { SettingsManager }, { AuthStorage }, { ModelRegistry }, { DefaultResourceLoader }] = await Promise.all([
  import(pathToFileURL(join(process.env.PRIME_AGENT_CORE_ROOT, "dist/agent.js")).href),
  imp("core/agent-session.js"), imp("core/session-manager.js"), imp("core/settings-manager.js"), imp("core/auth-storage.js"), imp("core/model-registry.js"), imp("core/resource-loader.js"),
]);
const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-poc-"));
const agentDir = join(cwd, ".agent");
const auth = AuthStorage.inMemory(); auth.set("poc", { type: "api_key", key: "not-a-real-key" });
const registry = ModelRegistry.inMemory(auth);
const settings = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 } });
const trace = [];
let calls = 0;
const model = { provider: "poc", id: "fake", api: "openai-completions", contextWindow: 100000, reasoning: false };
let agentRef;
let cancelRequested = false;
const responseFor = () => {
  const attempt = calls++;
  const text = attempt === 0 ? "normal response" : "continuation response";
  const message = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: Date.now() };
  return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: "stop", message }; }, async result() { return message; } };
};
const extension = (pi) => {
  let compactRequested = false;
  pi.on("turn_end", (event, ctx) => {
    trace.push({ hook: "turn_end", role: event.message?.role, stopReason: event.message?.stopReason });
    if (!compactRequested && event.message?.role === "assistant" && !event.message.content?.some((part) => part.type === "toolCall")) {
      compactRequested = true;
      ctx.compact({ customInstructions: "RALPH POC BOOTSTRAP" });
    }
  });
  pi.on("session_before_compact", (event) => ({ compaction: { summary: "RALPH POC BOOTSTRAP", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { poc: true } } }));
  pi.on("session_compact", (event) => {
    trace.push({ hook: "session_compact", summary: event.compactionEntry.summary, fromExtension: event.fromExtension });
    // Trigger only after the compaction event returns; admission inside it deadlocks.
    setTimeout(() => pi.sendMessage({ customType: "goal_context", content: "<goal_context>continue</goal_context>", display: true, details: { source: "prime-ralph-poc" } }, { triggerTurn: true, deliverAs: "followUp" }), 0);
  });
};
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, extensionFactories: [extension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "POC" });
await loader.reload();
const sm = SessionManager.inMemory(cwd);
const agent = new Agent({ initialState: { systemPrompt: "POC", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] }, convertToLlm: () => [], streamFn: (...args) => {
  if (calls === 1) setTimeout(() => { cancelRequested = true; agentRef.abort(); }, 0);
  return responseFor(...args);
} });
agentRef = agent;
const session = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, includeGoals: false, includeCompactSkill: true });
session.subscribe((event) => { if (["turn_end", "agent_end", "compaction_start", "compaction_end", "goal_update"].includes(event.type)) trace.push({ type: event.type, reason: event.reason, status: event.goal?.status, summary: event.result?.summary }); });
await agent.prompt("initial");
await agent.waitForIdle();
await new Promise((resolve) => setTimeout(resolve, 500));
const entries = sm.getBranch();
const compaction = entries.find((entry) => entry.type === "compaction");
const postCompactionGoal = entries.some((entry) => (entry.type === "custom" || entry.type === "custom_message") && entry.customType === "goal_context" && compaction && entries.indexOf(entry) > entries.indexOf(compaction));
const result = { cwd, calls, cancelRequested, trace, entries: entries.map((e) => ({ type: e.type, customType: e.customType, summary: e.summary, firstKeptEntryId: e.firstKeptEntryId })), compactionApplied: Boolean(compaction), postCompactionGoalContext: postCompactionGoal };
if (!compaction || calls !== 2 || !cancelRequested || !postCompactionGoal || !trace.some((entry) => entry.type === "agent_end")) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));
