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
  import(pathToFileURL(join(coreRoot, "dist/agent.js")).href), imp("core/agent-session.js"), imp("core/session-manager.js"), imp("core/settings-manager.js"),
  imp("core/auth-storage.js"), imp("core/model-registry.js"), imp("core/resource-loader.js"), imp("core/messages.js"),
]);
const model = { provider: "poc", id: "fake", api: "openai-completions", contextWindow: 100000, maxTokens: 1000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function assistant(text) { return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, timestamp: Date.now() }; }
function response(message) { return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: "stop", message }; }, async result() { return message; } }; }
const text = (context) => context.messages.map((message) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => part?.text ?? "").join("") : "").join("\n");
const waitFor = async (predicate, label) => { const deadline = Date.now() + 8000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`); await new Promise((resolve) => setTimeout(resolve, 10)); } };

async function fixture({ activeSpecification, activePlan = false }) {
  const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-planning-acceptance-"));
  const sessionDir = join(cwd, "sessions"), agentDir = join(cwd, ".agent");
  for (const dir of [".ralph/skills/prepare", ".ralph/skills/spec-it-out", ".ralph/skills/plan", ".ralph/plans", ".prime/agent/extensions", "sessions", ".agent"]) await mkdir(join(cwd, dir), { recursive: true });
  await symlink(new URL("../src", import.meta.url), join(cwd, ".prime/agent/extensions/prime-ralph"), "dir");
  const sentinels = {
    prepare: "PREPARE_SENTINEL_SLICE4_02c1", plan: "PLAN_SKILL_SENTINEL_SLICE4_7ab3", spec: "SPEC_SKILL_SENTINEL_SLICE4_9d54",
    stale: "STALE_PLANNING_CONVERSATION_SLICE4_c2f8", later: "LATER_PLANNING_CONVERSATION_SLICE4_901a",
  };
  await writeFile(join(cwd, ".ralph/skills/prepare/SKILL.md"), `---\nname: prepare\ndescription: test\n---\n${sentinels.prepare}\n`);
  await writeFile(join(cwd, ".ralph/skills/spec-it-out/SKILL.md"), `---\nname: spec-it-out\ndescription: test\nprime-ralph-invocation-version: 1\n---\n${sentinels.spec}\n`);
  await writeFile(join(cwd, ".ralph/skills/plan/SKILL.md"), `---\nname: plan\ndescription: test\nprime-ralph-invocation-version: 1\n---\n${sentinels.plan}\n`);
  if (activeSpecification) await writeFile(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# Fixture specification\n");
  if (activePlan) await writeFile(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# Existing startup plan\n");
  const auth = AuthStorage.inMemory(); auth.set("poc", { type: "api_key", key: "not-a-real-key" });
  const registry = ModelRegistry.inMemory(auth); const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, additionalExtensionPaths: [join(cwd, ".prime/agent/extensions/prime-ralph/index.js")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "SLICE4_BASELINE" });
  await loader.reload(); if (loader.getExtensions().errors.length) throw new Error(`extension load failed: ${JSON.stringify(loader.getExtensions().errors)}`);
  const sm = SessionManager.create(cwd, sessionDir), id = sm.getSessionId(), contexts = []; let hostSession;
  const agent = new Agent({ initialState: { systemPrompt: "SLICE4_BASELINE", model, thinkingLevel: "off", serviceTier: "auto", messages: [], tools: [] }, convertToLlm,
    transformContext: async (messages) => hostSession ? hostSession._extensionRunner.emitContext(messages) : messages,
    streamFn: async (_model, context) => { contexts.push(structuredClone(context)); return response(assistant(`provider-call-${contexts.length}`)); }, sessionId: id });
  const session = hostSession = new AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, agentDir, resourceLoader: loader, modelRegistry: registry, customTools: [], initialActiveToolNames: [], allowedToolNames: [], includeGoals: false, includeCompactSkill: false });
  await session.bindExtensions({});
  await waitFor(() => contexts.length >= 1 && !session.isStreaming, "startup turn");
  return { cwd, session, sm, contexts, id, sentinels, loader };
}

const startup = await fixture({ activeSpecification: true });
const startupContext = startup.contexts[0];
await startup.session.promptAndWait(startup.sentinels.stale);
let before = startup.contexts.length; await startup.session.prompt("/reset"); await waitFor(() => startup.contexts.length > before && !startup.session.isStreaming, "planning reset without plan");
const resetNewContext = startup.contexts.at(-1);
await writeFile(join(startup.cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# Protected fixture plan\n");
await startup.session.promptAndWait(startup.sentinels.later);
before = startup.contexts.length; await startup.session.prompt("/plan"); await waitFor(() => startup.contexts.length > before && !startup.session.isStreaming, "existing plan discussion");
const existingCommandContext = startup.contexts.at(-1);
const planAfterCommand = await readFile(join(startup.cwd, ".ralph/plans/EXECUTION_PLAN.md"), "utf8");
before = startup.contexts.length; await startup.session.prompt("/reset"); await waitFor(() => startup.contexts.length > before && !startup.session.isStreaming, "planning reset with plan");
const resetExistingContext = startup.contexts.at(-1);

const existingStartup = await fixture({ activeSpecification: true, activePlan: true });
const existingStartupContext = existingStartup.contexts[0];
const existingStartupPlan = await readFile(join(existingStartup.cwd, ".ralph/plans/EXECUTION_PLAN.md"), "utf8");

const transition = await fixture({ activeSpecification: false });
await writeFile(join(transition.cwd, ".ralph/plans/SPECIFICATION.md"), "# Created during specification phase\n");
await transition.session.promptAndWait(transition.sentinels.stale);
before = transition.contexts.length; await transition.session.prompt("/reset"); await waitFor(() => transition.contexts.length > before && !transition.session.isStreaming, "specification reset after spec creation");
const specificationResetContext = transition.contexts.at(-1);
before = transition.contexts.length; await transition.session.prompt("/plan"); await waitFor(() => transition.contexts.length > before && !transition.session.isStreaming, "explicit planning transition");
const explicitPlanContext = transition.contexts.at(-1);
const commandNames = [...startup.loader.getExtensions().extensions[0].commands.keys()];
const result = {
  primeAgentVersion: JSON.parse(await readFile(join(primeRoot, "package.json"), "utf8")).version,
  registeredCommands: commandNames,
  startupOrdered: text(startupContext).indexOf(startup.sentinels.prepare) < text(startupContext).indexOf(startup.sentinels.plan),
  startupNewMode: text(startupContext).includes('"invocationMode":"planning-new"'),
  startupSingleMessage: startupContext.messages.length === 1,
  existingStartupMode: text(existingStartupContext).includes('"invocationMode":"planning-existing"') && text(existingStartupContext).indexOf(existingStartup.sentinels.prepare) < text(existingStartupContext).indexOf(existingStartup.sentinels.plan),
  existingStartupProtected: existingStartupPlan === "# Existing startup plan\n",
  resetNewClean: text(resetNewContext).includes('"invocationMode":"planning-reset-new"') && !text(resetNewContext).includes(startup.sentinels.stale),
  existingPlanCurrentContext: text(existingCommandContext).includes('"invocationMode":"planning-existing"') && text(existingCommandContext).includes(startup.sentinels.later) && !text(existingCommandContext).includes(startup.sentinels.stale),
  existingPlanProtected: planAfterCommand === "# Protected fixture plan\n",
  resetExistingClean: text(resetExistingContext).includes('"invocationMode":"planning-reset-existing"') && ![startup.sentinels.stale, startup.sentinels.later].some((value) => text(resetExistingContext).includes(value)),
  specificationPhasePreserved: text(specificationResetContext).includes('"invocationMode":"specification-reset-existing"') && !text(specificationResetContext).includes(startup.sentinels.plan),
  explicitPlanClean: text(explicitPlanContext).includes('"invocationMode":"planning-new"') && !text(explicitPlanContext).includes(transition.sentinels.stale),
  sameSessionTransition: transition.sm.getSessionId() === transition.id,
  planHandlerDidNotWrite: !existsSync(join(transition.cwd, ".ralph/plans/EXECUTION_PLAN.md")),
  executionEntries: [...startup.sm.getEntries(), ...transition.sm.getEntries()].filter((entry) => /execute|goal|blocked/.test(entry.customType ?? "")).length,
};
const failures = [];
if (result.primeAgentVersion !== "0.9.1") failures.push("wrong Prime Agent version");
if (JSON.stringify(result.registeredCommands) !== JSON.stringify(["reset", "spec-it-out", "plan", "execute"])) failures.push("wrong command surface");
for (const key of ["startupOrdered", "startupNewMode", "startupSingleMessage", "existingStartupMode", "existingStartupProtected", "resetNewClean", "existingPlanCurrentContext", "existingPlanProtected", "resetExistingClean", "specificationPhasePreserved", "explicitPlanClean", "sameSessionTransition", "planHandlerDidNotWrite"]) if (!result[key]) failures.push(key);
if (result.executionEntries !== 0) failures.push("execution state was introduced");
await startup.session.disposeAsync({ kernelSnapshot: false }); await existingStartup.session.disposeAsync({ kernelSnapshot: false }); await transition.session.disposeAsync({ kernelSnapshot: false });
if (failures.length) { console.error(JSON.stringify({ ...result, failures }, null, 2)); process.exit(1); }
console.log(JSON.stringify(result, null, 2));
