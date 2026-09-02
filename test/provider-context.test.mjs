import test from "node:test";
import assert from "node:assert/strict";
import { projectRalphBootstrapContext } from "../src/ralph-context.js";
import ralphContextExtension from "../src/ralph-context-extension.js";

test("provider snapshot contains stable summary followed by goal context only", () => {
  const projected = projectRalphBootstrapContext([
    { role: "compactionSummary", summary: "RALPH_BOOTSTRAP: study the repo" },
    { role: "assistant", content: [{ type: "text", text: "stale" }] },
    { role: "custom", customType: "goal_context", content: "<goal_context>continue</goal_context>", display: true },
  ]);
  // Prime Agent's convertToLlm maps compactionSummary and custom messages to user messages.
  // The actual conversion is exercised by the environment-configured POC scripts.
  assert.deepEqual(projected.map((message) => message.role), ["compactionSummary", "custom"]);
  assert.match(projected[0].summary, /RALPH_BOOTSTRAP/);
  assert.equal(projected[1].content, "<goal_context>continue</goal_context>");
});

test("context extension is inactive until a Ralph custom compaction completes", () => {
  const handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); } };
  ralphContextExtension(pi);
  const messages = [{ role: "compactionSummary", summary: "RALPH_BOOTSTRAP: x" }, { role: "assistant", content: [] }];
  assert.equal(handlers.get("context")({ messages }), undefined);
  handlers.get("session_compact")({ fromExtension: true, compactionEntry: { summary: "RALPH_BOOTSTRAP: x" } });
  const result = handlers.get("context")({ messages });
  assert.deepEqual(result.messages, [messages[0]]);
});
