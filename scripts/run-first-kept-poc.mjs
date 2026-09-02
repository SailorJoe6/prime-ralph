import { pathToFileURL } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const primeRoot = process.env.PRIME_AGENT_SOURCE_ROOT;
if (!primeRoot) throw new Error("PRIME_AGENT_SOURCE_ROOT required");
const imp = (p) => import(pathToFileURL(join(primeRoot, "dist", p)).href);
const [{ SessionManager }, { convertToLlm }] = await Promise.all([imp("core/session-manager.js"), imp("core/messages.js")]);
const cases = ["firstUser", "lastAssistant", "marker", "goalContext", "invalid"];
const result = {};
for (const name of cases) {
  const cwd = await mkdtemp(join(tmpdir(), "prime-ralph-first-kept-"));
  const sm = SessionManager.inMemory(cwd);
  const userId = sm.appendMessage({ role: "user", content: [{ type: "text", text: "STATIC RALPH TASK: study the repository" }], timestamp: Date.now() });
  const assistantId = sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "completed attempt" }], api: "poc", provider: "poc", model: "fake", stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: Date.now() });
  const markerId = sm.appendCustomEntry("prime-ralph-marker", { purpose: "new-completion-boundary" });
  const goalId = sm.appendCustomMessageEntry("goal_context", "<goal_context>continue</goal_context>", true, { kind: "continuation" });
  const ids = { firstUser: userId, lastAssistant: assistantId, marker: markerId, goalContext: goalId, invalid: "does-not-exist" };
  sm.appendCompaction("RALPH BOOTSTRAP", ids[name], 100, { case: name }, true);
  const context = sm.buildSessionContext();
  const llm = convertToLlm(context.messages);
  result[name] = { firstKeptEntryId: ids[name], contextRoles: context.messages.map((m) => m.role), llmRoles: llm.map((m) => m.role), texts: llm.map((m) => m.content?.map?.((part) => part.text).join("") ?? "") };
}
console.log(JSON.stringify({ note: "invalid is diagnostic only; do not use an unsupported boundary in production", result }, null, 2));
