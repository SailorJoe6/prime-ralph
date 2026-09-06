import test from "node:test";
import assert from "node:assert/strict";
import { isFinalNormalAssistantTurn, isQueuedToolHandoff } from "../src/cycle-boundary.js";

const normal = { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }, toolResults: [] };

test("recognizes a final normal assistant turn", () => assert.equal(isFinalNormalAssistantTurn(normal), true));
test("does not classify tool-call turns as cycle boundaries", () => assert.equal(isFinalNormalAssistantTurn({ ...normal, message: { ...normal.message, content: [{ type: "toolCall" }] } }), false));
test("accepts final responses after tool results but rejects errors and aborts", () => {
  assert.equal(isFinalNormalAssistantTurn({ ...normal, toolResults: [{}] }), true);
  assert.equal(isFinalNormalAssistantTurn({ ...normal, message: { ...normal.message, stopReason: "error" } }), false);
  assert.equal(isFinalNormalAssistantTurn({ ...normal, message: { ...normal.message, stopReason: "aborted" } }), false);
});


test("recognizes only a current tool-use response with tool calls and queued host work", () => {
  const event = { messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "goal", arguments: {} }] }] };
  assert.equal(isQueuedToolHandoff(event, { signal: new AbortController().signal, hasPendingMessages: () => true }), true);
  assert.equal(isQueuedToolHandoff(event, { signal: new AbortController().signal, hasPendingMessages: () => false }), false);
  assert.equal(isQueuedToolHandoff({ messages: [{ role: "assistant", stopReason: "toolUse", content: [] }] }, { signal: new AbortController().signal, hasPendingMessages: () => true }), false);
  assert.equal(isQueuedToolHandoff({ messages: [event.messages[0], { role: "assistant", stopReason: "error", content: [] }] }, { signal: new AbortController().signal, hasPendingMessages: () => true }), false);
  assert.equal(isQueuedToolHandoff({ messages: [event.messages[0], { role: "assistant", stopReason: "aborted", content: [] }] }, { signal: new AbortController().signal, hasPendingMessages: () => true }), false);
  const aborted = new AbortController(); aborted.abort();
  assert.equal(isQueuedToolHandoff(event, { signal: aborted.signal, hasPendingMessages: () => true }), false);
  assert.equal(isQueuedToolHandoff(event, { signal: undefined, hasPendingMessages: () => true }), false);
  assert.equal(isQueuedToolHandoff({ messages: [] }, { signal: new AbortController().signal, hasPendingMessages: () => true }), false);
});
