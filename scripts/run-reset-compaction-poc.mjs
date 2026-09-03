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

const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-compaction-poc-"));
const sessionDir = join(cwd, "sessions");
const agentDir = join(cwd, ".agent");
const extensionDir = join(cwd, ".prime/agent/extensions/prime-ralph-compaction-poc");
await Promise.all([
  mkdir(join(cwd, ".ralph/skills/prepare"), { recursive: true }),
  mkdir(extensionDir, { recursive: true }), mkdir(sessionDir, { recursive: true }), mkdir(agentDir, { recursive: true }),
]);
const prepareSentinel = "PREPARE_COMPACTION_POC_98fc7";
const staleSentinel = "STALE_COMPACTION_POC_2bc14";
await writeFile(join(cwd, ".ralph/skills/prepare/SKILL.md"), `---\nname: prepare\ndescription: Compaction POC fixture\n---\n\n${prepareSentinel}\n`);
const extensionSource = `
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const MARKER = "prime_ralph_reset_marker_poc";
const PREPARE = "prime_ralph_reset_prepare_poc";
const INSTRUCTION_PREFIX = "prime-ralph-reset-poc:v1:";
export default function (pi) {
  let pending;
  pi.registerCommand("reset", {
    description: "POC compaction reset",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("Usage: /reset");
      if (pending) throw new Error("reset already active");
      const content = readFileSync(join(ctx.cwd, ".ralph/skills/prepare/SKILL.md"), "utf8");
      const requestId = randomUUID();
      pi.appendEntry(MARKER, { source: "prime-ralph", version: 1, requestId });
      const marker = ctx.sessionManager.getBranch().at(-1);
      if (marker?.type !== "custom" || marker.customType !== MARKER || marker.data?.requestId !== requestId || !marker.id) {
        throw new Error("durable reset marker was not synchronously observable");
      }
      const customInstructions = INSTRUCTION_PREFIX + requestId;
      const injectPrepare = (mode) => {
        pi.sendMessage({
          customType: PREPARE,
          content: '<skill name="prepare" location=".ralph/skills/prepare/SKILL.md">\\n' + content + '\\n</skill>',
          display: false,
          details: { source: "prime-ralph", version: 1, requestId, mode },
        }, { triggerTurn: true, deliverAs: "followUp" });
        pending = undefined;
      };
      pending = { requestId, markerId: marker.id, customInstructions, content };
      ctx.compact({
        customInstructions,
        onComplete: (result) => {
          if (result.firstKeptEntryId !== marker.id || result.summary !== "") {
            pi.appendEntry("prime_ralph_reset_poc_error", { requestId, reason: "unexpected_compaction_result" });
            pending = undefined;
            return;
          }
          injectPrepare("compaction");
        },
        onError: (error) => {
          const reason = String(error?.message ?? error);
          if (reason.includes("Session is too short to compact") || reason.includes("Already compacted")) {
            injectPrepare("projection-fallback");
            return;
          }
          pi.appendEntry("prime_ralph_reset_poc_error", { requestId, reason });
          pending = undefined;
        },
      });
    },
  });
  pi.on("session_before_compact", async (event) => {
    if (!pending || event.customInstructions !== pending.customInstructions) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const marker = event.branchEntries.find((entry) => entry.id === pending.markerId);
    if (!marker || marker.type !== "custom" || marker.customType !== MARKER) return { cancel: true };
    return { compaction: { summary: "", firstKeptEntryId: marker.id, tokensBefore: event.preparation.tokensBefore, details: { source: "prime-ralph", version: 1, requestId: pending.requestId } } };
  });
  pi.on("context", (event) => {
    const first = event.messages[0];
    if (first?.role === "compactionSummary" && first.summary === "" && first.customInstructions?.startsWith(INSTRUCTION_PREFIX)) {
      return { messages: event.messages.slice(1) };
    }
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (message?.role === "custom" && message.customType === PREPARE && message.details?.mode === "projection-fallback") {
        return { messages: event.messages.slice(index) };
      }
    }
  });
}
`;
await writeFile(join(extensionDir, "index.js"), extensionSource);

const auth = AuthStorage.inMemory(); auth.set("poc", { type: "api_key", key: "not-a-real-key" });
const registry = ModelRegistry.inMemory(auth);
const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1000 } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(extensionDir, "index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "HOST_BASELINE_COMPACTION_POC" });
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
const sm = SessionManager.create(cwd, sessionDir);
const model = { provider: "poc", id: "fake", api: "openai-completions", contextWindow: 200000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const contexts = [];
let calls = 0;
function assistant(text) { return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() }; }
function response(message) { return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: "stop", message }; }, async result() { return message; } }; }
let hostSession;
const agent = new Agent({
  initialState: { systemPrompt: "HOST_BASELINE_COMPACTION_POC", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] },
  convertToLlm,
  transformContext: async (messages) => hostSession ? hostSession._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => { contexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) }); calls += 1; return response(assistant(`response-${calls}`)); },
  sessionId: sm.getSessionId(),
});
const session = hostSession = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, customTools: [], includeGoals: false, includeCompactSkill: false });
for (let turn = 0; turn < 4; turn += 1) {
  await session.promptAndWait(`${turn === 0 ? staleSentinel : `old-turn-${turn}`}\n${"old context ".repeat(2500)}`);
}
await session.prompt("/reset");
for (let i = 0; i < 1000 && (calls < 5 || session.isStreaming || session.unfinishedActionCount > 0); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
await session.waitForIdle();
const entries = sm.getEntries();
const branch = sm.getBranch();
const compactions = entries.filter((entry) => entry.type === "compaction");
const markers = entries.filter((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_marker_poc");
const prepares = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare_poc");
const resetContext = contexts[4];
const resetText = JSON.stringify(resetContext ?? null);
const rebuilt = sm.buildSessionContext();
const result = {
  cwd, calls, compactions: compactions.length, markers: markers.length, prepares: prepares.length,
  realMarkerRetained: compactions[0]?.firstKeptEntryId === markers[0]?.id,
  fromExtension: compactions[0]?.fromHook === true || compactions[0]?.fromExtension === true,
  summaryEmpty: compactions[0]?.summary === "",
  wrapperExcluded: !resetContext?.messages?.some((message) => JSON.stringify(message).includes("conversation history before this point was compacted")),
  staleExcluded: resetContext !== undefined && !resetText.includes(staleSentinel), prepareOnce: resetContext !== undefined && resetText.split(prepareSentinel).length - 1 === 1,
  resetRoles: resetContext?.messages?.map((message) => message.role),
  rebuiltRoles: rebuilt.messages.map((message) => message.role),
  rebuiltHasCompactionSummary: rebuilt.messages.some((message) => message.role === "compactionSummary"),
  jsonlRetainsStale: (await readFile(session.sessionFile, "utf8")).includes(staleSentinel),
  entryTypes: entries.map((entry) => ({ type: entry.type, customType: entry.customType, summary: entry.summary, customInstructions: entry.customInstructions, data: entry.data })),
  unfinishedActionCount: session.unfinishedActionCount,
  isStreaming: session.isStreaming,
};
const failures = Object.entries({ fiveCalls: calls === 5, oneCompaction: compactions.length === 1, oneMarker: markers.length === 1, onePrepare: prepares.length === 1, realMarkerRetained: result.realMarkerRetained, summaryEmpty: result.summaryEmpty, wrapperExcluded: result.wrapperExcluded, staleExcluded: result.staleExcluded, prepareOnce: result.prepareOnce, rebuiltHasCompactionSummary: result.rebuiltHasCompactionSummary, jsonlRetainsStale: result.jsonlRetainsStale }).filter(([, ok]) => !ok).map(([name]) => name);
const originalSessionFile = session.sessionFile;
const originalSessionId = session.sessionId;
await session.disposeAsync({ kernelSnapshot: false });

const resumedLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(extensionDir, "index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "HOST_BASELINE_COMPACTION_POC" });
await resumedLoader.reload();
const resumedSm = await SessionManager.openAsync(originalSessionFile, sessionDir, cwd);
const resumedContexts = [];
let resumedSession;
const resumedAgent = new Agent({
  initialState: { systemPrompt: "HOST_BASELINE_COMPACTION_POC", model, thinkingLevel: "off", serviceTier: "auto", messages: resumedSm.buildSessionContext().messages, tools: [] },
  convertToLlm,
  transformContext: async (messages) => resumedSession ? resumedSession._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => { resumedContexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) }); return response(assistant("resumed-response")); },
  sessionId: resumedSm.getSessionId(),
});
resumedSession = new AgentSession({ agent: resumedAgent, sessionManager: resumedSm, settingsManager: settings, cwd, agentDir, resourceLoader: resumedLoader, modelRegistry: registry, customTools: [], includeGoals: false, includeCompactSkill: false });
await resumedSession.promptAndWait("POST_RESUME_POC_PROMPT");
const resumedText = JSON.stringify(resumedContexts[0] ?? null);
Object.assign(result, {
  resumeSameSession: resumedSession.sessionId === originalSessionId && resumedSession.sessionFile === originalSessionFile,
  resumeProviderCalls: resumedContexts.length,
  resumeRoles: resumedContexts[0]?.messages?.map((message) => message.role),
  resumeStaleExcluded: !resumedText.includes(staleSentinel),
  resumeWrapperExcluded: !resumedText.includes("conversation history before this point was compacted"),
  resumePrepareOnce: resumedText.split(prepareSentinel).length - 1 === 1,
});
for (const [name, ok] of Object.entries({ resumeSameSession: result.resumeSameSession, oneResumeCall: result.resumeProviderCalls === 1, resumeStaleExcluded: result.resumeStaleExcluded, resumeWrapperExcluded: result.resumeWrapperExcluded, resumePrepareOnce: result.resumePrepareOnce })) if (!ok) failures.push(name);
await resumedSession.disposeAsync({ kernelSnapshot: false });

const shortSessionDir = join(cwd, "short-sessions");
await mkdir(shortSessionDir, { recursive: true });
const shortLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(extensionDir, "index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "HOST_BASELINE_COMPACTION_POC" });
await shortLoader.reload();
const shortSm = SessionManager.create(cwd, shortSessionDir);
const shortContexts = [];
let shortCalls = 0;
let shortSession;
const shortAgent = new Agent({
  initialState: { systemPrompt: "HOST_BASELINE_COMPACTION_POC", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] },
  convertToLlm,
  transformContext: async (messages) => shortSession ? shortSession._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => { shortContexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) }); shortCalls += 1; return response(assistant(`short-response-${shortCalls}`)); },
  sessionId: shortSm.getSessionId(),
});
shortSession = new AgentSession({ agent: shortAgent, sessionManager: shortSm, settingsManager: settings, cwd, agentDir, resourceLoader: shortLoader, modelRegistry: registry, customTools: [], includeGoals: false, includeCompactSkill: false });
await shortSession.promptAndWait(`SHORT_${staleSentinel}`);
await shortSession.prompt("/reset");
for (let i = 0; i < 1000 && (shortCalls < 2 || shortSession.isStreaming || shortSession.unfinishedActionCount > 0); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
await shortSession.waitForIdle();
const shortEntries = shortSm.getEntries();
const shortText = JSON.stringify(shortContexts[1] ?? null);
Object.assign(result, {
  shortCalls,
  shortCompactions: shortEntries.filter((entry) => entry.type === "compaction").length,
  shortMarkers: shortEntries.filter((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_marker_poc").length,
  shortPrepares: shortEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare_poc").length,
  shortStaleExcluded: !shortText.includes(staleSentinel),
  shortPrepareOnce: shortText.split(prepareSentinel).length - 1 === 1,
  shortRoles: shortContexts[1]?.messages?.map((message) => message.role),
});
for (const [name, ok] of Object.entries({ shortTwoCalls: result.shortCalls === 2, shortNoCompaction: result.shortCompactions === 0, shortOneMarker: result.shortMarkers === 1, shortOnePrepare: result.shortPrepares === 1, shortStaleExcluded: result.shortStaleExcluded, shortPrepareOnce: result.shortPrepareOnce })) if (!ok) failures.push(name);
const shortFile = shortSession.sessionFile;
const shortId = shortSession.sessionId;
await shortSession.disposeAsync({ kernelSnapshot: false });

const shortResumeLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(extensionDir, "index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "HOST_BASELINE_COMPACTION_POC" });
await shortResumeLoader.reload();
const shortResumeSm = await SessionManager.openAsync(shortFile, shortSessionDir, cwd);
const shortResumeContexts = [];
let shortResumeSession;
const shortResumeAgent = new Agent({
  initialState: { systemPrompt: "HOST_BASELINE_COMPACTION_POC", model, thinkingLevel: "off", serviceTier: "auto", messages: shortResumeSm.buildSessionContext().messages, tools: [] },
  convertToLlm,
  transformContext: async (messages) => shortResumeSession ? shortResumeSession._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => { shortResumeContexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) }); return response(assistant("short-resume-response")); },
  sessionId: shortResumeSm.getSessionId(),
});
shortResumeSession = new AgentSession({ agent: shortResumeAgent, sessionManager: shortResumeSm, settingsManager: settings, cwd, agentDir, resourceLoader: shortResumeLoader, modelRegistry: registry, customTools: [], includeGoals: false, includeCompactSkill: false });
await shortResumeSession.promptAndWait("SHORT_RESUME_PROMPT");
const shortResumeText = JSON.stringify(shortResumeContexts[0] ?? null);
Object.assign(result, {
  shortResumeSameSession: shortResumeSession.sessionId === shortId && shortResumeSession.sessionFile === shortFile,
  shortResumeStaleExcluded: !shortResumeText.includes(staleSentinel),
  shortResumePrepareOnce: shortResumeText.split(prepareSentinel).length - 1 === 1,
});
for (const [name, ok] of Object.entries({ shortResumeSameSession: result.shortResumeSameSession, shortResumeStaleExcluded: result.shortResumeStaleExcluded, shortResumePrepareOnce: result.shortResumePrepareOnce })) if (!ok) failures.push(name);
await shortResumeSession.disposeAsync({ kernelSnapshot: false });

const cancelSessionDir = join(cwd, "cancel-sessions");
await mkdir(cancelSessionDir, { recursive: true });
const cancelLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(extensionDir, "index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "HOST_BASELINE_COMPACTION_POC" });
await cancelLoader.reload();
const cancelSm = SessionManager.create(cwd, cancelSessionDir);
const cancelContexts = [];
let cancelCalls = 0;
let cancelSession;
const cancelAgent = new Agent({
  initialState: { systemPrompt: "HOST_BASELINE_COMPACTION_POC", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] },
  convertToLlm,
  transformContext: async (messages) => cancelSession ? cancelSession._extensionRunner.emitContext(messages) : messages,
  streamFn: async (_model, context) => { cancelContexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) }); cancelCalls += 1; return response(assistant(`cancel-response-${cancelCalls}`)); },
  sessionId: cancelSm.getSessionId(),
});
cancelSession = new AgentSession({ agent: cancelAgent, sessionManager: cancelSm, settingsManager: settings, cwd, agentDir, resourceLoader: cancelLoader, modelRegistry: registry, customTools: [], includeGoals: false, includeCompactSkill: false });
for (let turn = 0; turn < 4; turn += 1) await cancelSession.promptAndWait(`${turn === 0 ? `CANCEL_${staleSentinel}` : `cancel-old-${turn}`}\n${"old context ".repeat(2500)}`);
await cancelSession.prompt("/reset");
for (let i = 0; i < 1000 && !cancelSession.isCompacting; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
const observedCompacting = cancelSession.isCompacting;
cancelSession.abortCompaction();
for (let i = 0; i < 1000 && (cancelSession.isCompacting || cancelSession.unfinishedActionCount > 0); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
const cancelledEntries = cancelSm.getEntries();
const cancelledCompactions = cancelledEntries.filter((entry) => entry.type === "compaction").length;
const cancelledPrepares = cancelledEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare_poc").length;
const cancellationErrors = cancelledEntries.filter((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_poc_error");
await cancelSession.prompt("/reset");
for (let i = 0; i < 1000 && (cancelCalls < 5 || cancelSession.isStreaming || cancelSession.isCompacting || cancelSession.unfinishedActionCount > 0); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
await cancelSession.waitForIdle();
const retryEntries = cancelSm.getEntries();
const retryText = JSON.stringify(cancelContexts[4] ?? null);
Object.assign(result, {
  cancellationObservedCompacting: observedCompacting,
  cancelledCompactions,
  cancelledPrepares,
  cancellationErrors: cancellationErrors.length,
  cancellationReason: cancellationErrors[0]?.data?.reason,
  retryCompactions: retryEntries.filter((entry) => entry.type === "compaction").length,
  retryMarkers: retryEntries.filter((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_marker_poc").length,
  retryPrepares: retryEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare_poc").length,
  retryStaleExcluded: !retryText.includes(staleSentinel),
  retryPrepareOnce: retryText.split(prepareSentinel).length - 1 === 1,
});
for (const [name, ok] of Object.entries({ cancellationObservedCompacting: result.cancellationObservedCompacting, cancelledNoCompaction: result.cancelledCompactions === 0, cancelledNoPrepare: result.cancelledPrepares === 0, oneCancellationError: result.cancellationErrors === 1, retryOneCompaction: result.retryCompactions === 1, retryTwoMarkers: result.retryMarkers === 2, retryOnePrepare: result.retryPrepares === 1, retryStaleExcluded: result.retryStaleExcluded, retryPrepareOnce: result.retryPrepareOnce })) if (!ok) failures.push(name);
for (let turn = 0; turn < 4; turn += 1) await cancelSession.promptAndWait(`between-reset-${turn}\n${"new context ".repeat(2500)}`);
await cancelSession.prompt("/reset");
for (let i = 0; i < 1000 && (cancelCalls < 10 || cancelSession.isStreaming || cancelSession.isCompacting || cancelSession.unfinishedActionCount > 0); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
await cancelSession.waitForIdle();
const secondResetEntries = cancelSm.getEntries();
const secondResetText = JSON.stringify(cancelContexts[9] ?? null);
Object.assign(result, {
  settledCompactionsAfterSecondReset: secondResetEntries.filter((entry) => entry.type === "compaction").length,
  markersAfterSecondReset: secondResetEntries.filter((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_marker_poc").length,
  preparesAfterSecondReset: secondResetEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare_poc").length,
  secondResetStaleExcluded: !secondResetText.includes(staleSentinel) && !secondResetText.includes("between-reset-0"),
  secondResetPrepareOnce: secondResetText.split(prepareSentinel).length - 1 === 1,
});
for (const [name, ok] of Object.entries({ twoSettledCompactions: result.settledCompactionsAfterSecondReset === 2, threeMarkersIncludingCancelled: result.markersAfterSecondReset === 3, twoPrepareEntries: result.preparesAfterSecondReset === 2, secondResetStaleExcluded: result.secondResetStaleExcluded, secondResetPrepareOnce: result.secondResetPrepareOnce })) if (!ok) failures.push(name);
await cancelSession.disposeAsync({ kernelSnapshot: false });
if (failures.length) { console.error(JSON.stringify({ ...result, failures }, null, 2)); process.exit(1); }
console.log(JSON.stringify(result, null, 2));
process.exit(0);
