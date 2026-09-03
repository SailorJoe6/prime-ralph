import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
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

const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-reset-lifecycle-"));
const sessionRoot = join(cwd, "sessions");
const agentRoot = join(cwd, ".agent");
const extensionRoot = join(cwd, ".prime/agent/extensions");
await Promise.all([mkdir(join(cwd, ".ralph/skills/prepare"), { recursive: true }), mkdir(extensionRoot, { recursive: true }), mkdir(sessionRoot), mkdir(agentRoot)]);
await symlink(new URL("../src", import.meta.url), join(extensionRoot, "prime-ralph"), "dir");
const delayDir = join(extensionRoot, "delay-compaction");
await mkdir(delayDir);
await writeFile(join(delayDir, "index.js"), `export default function (pi) { pi.on("session_before_compact", async (event) => { if (event.customInstructions?.startsWith("prime-ralph-reset:v2:")) await new Promise((resolve) => setTimeout(resolve, 100)); }); }\n`);
const prepareSentinel = "LIFECYCLE_PREPARE_4d61";
const staleSentinel = "LIFECYCLE_STALE_a90e";
await writeFile(join(cwd, ".ralph/skills/prepare/SKILL.md"), `---\nname: prepare\ndescription: Lifecycle acceptance fixture\n---\n\n${prepareSentinel}\n`);

const auth = AuthStorage.inMemory(); auth.set("poc", { type: "api_key", key: "none" });
const registry = ModelRegistry.inMemory(auth);
const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
const model = { provider: "poc", id: "fake", api: "openai-completions", contextWindow: 200000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function assistant(text, stopReason = "stop") { return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason, errorMessage: stopReason === "error" ? "injected provider failure" : undefined, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() }; }
function response(message) { return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: message.stopReason, message }; }, async result() { return message; } }; }
async function waitUntil(predicate, label) { for (let i = 0; i < 2000; i += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error(`timed out waiting for ${label}`); }
async function createRuntime(sm, { delay = false, responseFor = (index) => assistant(`response-${index}`) } = {}) {
  const loader = new DefaultResourceLoader({ cwd, agentDir: agentRoot, settingsManager: settings, additionalExtensionPaths: [...(delay ? [join(delayDir, "index.js")] : []), join(extensionRoot, "prime-ralph/index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "LIFECYCLE_BASELINE" });
  await loader.reload();
  if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
  const contexts = [];
  const state = { calls: 0 };
  let session;
  const agent = new Agent({
    initialState: { systemPrompt: "LIFECYCLE_BASELINE", model, thinkingLevel: "off", serviceTier: "auto", messages: sm.buildSessionContext().messages, tools: [] },
    convertToLlm,
    transformContext: async (messages) => session ? session._extensionRunner.emitContext(messages) : messages,
    streamFn: async (_model, context) => { const index = state.calls++; contexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) }); return response(responseFor(index)); },
    sessionId: sm.getSessionId(),
  });
  session = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir: agentRoot, resourceLoader: loader, modelRegistry: registry, customTools: [], includeGoals: false, includeCompactSkill: false });
  return { session, contexts, state };
}
async function grow(runtime, prefix) { for (let turn = 0; turn < 4; turn += 1) await runtime.session.promptAndWait(`${turn === 0 ? `${prefix}_${staleSentinel}` : `${prefix}_${turn}`}\n${"old context ".repeat(2500)}`); }
async function runReset(runtime, targetCalls) {
  await runtime.session.prompt("/reset");
  await waitUntil(() => runtime.state.calls >= targetCalls && !runtime.session.isStreaming && !runtime.session.isCompacting && runtime.session.unfinishedActionCount === 0, "reset settlement");
  await runtime.session.waitForIdle();
  await runtime.session._agentEventQueue;
  await runtime.session.waitForIdle();
}

// Durable custom-compaction reconstruction in a fresh runtime.
const resumeDir = join(sessionRoot, "resume"); await mkdir(resumeDir);
const resumeSm = SessionManager.create(cwd, resumeDir);
const beforeResume = await createRuntime(resumeSm);
await grow(beforeResume, "resume");
await runReset(beforeResume, 5);
const resumeFile = beforeResume.session.sessionFile;
const resumeId = beforeResume.session.sessionId;
const preResumeEntries = resumeSm.getEntries();
await beforeResume.session.disposeAsync({ kernelSnapshot: false });
const reopenedSm = await SessionManager.openAsync(resumeFile, resumeDir, cwd);
const afterResume = await createRuntime(reopenedSm);
await afterResume.session.promptAndWait("AFTER_REOPEN");
const resumedText = JSON.stringify(afterResume.contexts[0]);
const resumeEvidence = {
  sameSession: afterResume.session.sessionId === resumeId && afterResume.session.sessionFile === resumeFile,
  oneCompaction: preResumeEntries.filter((entry) => entry.type === "compaction" && entry.customInstructions?.startsWith("prime-ralph-reset:v2:")).length === 1,
  staleExcluded: !resumedText.includes(staleSentinel),
  wrapperExcluded: !resumedText.includes("conversation history before this point was compacted"),
  prepareOnce: resumedText.split(prepareSentinel).length - 1 === 1,
};
await afterResume.session.disposeAsync({ kernelSnapshot: false });

// Abort custom compaction, prove no partial prepare, retry into an injected provider failure, then reset again successfully.
const cancelDir = join(sessionRoot, "cancel"); await mkdir(cancelDir);
const cancelSm = SessionManager.create(cwd, cancelDir);
const cancelRuntime = await createRuntime(cancelSm, { delay: true, responseFor: (index) => index === 4 ? assistant("provider failed", "error") : assistant(`cancel-response-${index}`) });
await grow(cancelRuntime, "cancel");
await cancelRuntime.session.prompt("/reset");
await waitUntil(() => cancelRuntime.session.isCompacting, "active compaction");
cancelRuntime.session.abortCompaction();
await waitUntil(() => !cancelRuntime.session.isCompacting && cancelRuntime.session.unfinishedActionCount === 0, "cancelled compaction settlement");
const afterCancel = cancelSm.getEntries();
const cancelEvidence = {
  noCompaction: afterCancel.filter((entry) => entry.type === "compaction").length === 0,
  noPrepare: afterCancel.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare").length === 0,
  failedState: afterCancel.some((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_state" && entry.data?.status === "failed" && entry.data?.reason === "compaction_failed"),
};
await runReset(cancelRuntime, 5);
const afterProviderFailure = cancelSm.getEntries();
const failureText = JSON.stringify(cancelRuntime.contexts[4]);
const providerFailureEvidence = {
  oneBoundary: afterProviderFailure.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare").length === 1,
  prepareOnce: failureText.split(prepareSentinel).length - 1 === 1,
  staleExcluded: !failureText.includes(staleSentinel),
  failedState: afterProviderFailure.some((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_state" && entry.data?.status === "failed" && entry.data?.reason === "provider_error" && entry.data?.boundaryExists === true),
};
await runReset(cancelRuntime, 6);
const afterRetry = cancelSm.getEntries();
const retryText = JSON.stringify(cancelRuntime.contexts[5]);
const retryEvidence = {
  twoBoundaries: afterRetry.filter((entry) => entry.type === "custom_message" && entry.customType === "prime_ralph_reset_prepare").length === 2,
  latestPrepareOnce: retryText.split(prepareSentinel).length - 1 === 1,
  staleExcluded: !retryText.includes(staleSentinel),
  completedState: afterRetry.some((entry) => entry.type === "custom" && entry.customType === "prime_ralph_reset_state" && entry.data?.status === "completed"),
};
await cancelRuntime.session.disposeAsync({ kernelSnapshot: false });

const evidence = { primeAgentVersion: JSON.parse(await (await import("node:fs/promises")).readFile(join(primeRoot, "package.json"), "utf8")).version, resumeEvidence, cancelEvidence, providerFailureEvidence, retryEvidence };
const failures = [];
for (const [section, values] of Object.entries({ resumeEvidence, cancelEvidence, providerFailureEvidence, retryEvidence })) for (const [name, passed] of Object.entries(values)) if (!passed) failures.push(`${section}.${name}`);
if (evidence.primeAgentVersion !== "0.9.1") failures.push("primeAgentVersion");
if (failures.length) { console.error(JSON.stringify({ ...evidence, failures }, null, 2)); process.exit(1); }
console.log(JSON.stringify(evidence, null, 2));
process.exit(0);
