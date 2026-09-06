import test from "node:test";
import assert from "node:assert/strict";
import { isFinalNormalAssistantTurn } from "../src/cycle-boundary.js";

const normal = { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }, toolResults: [] };

test("recognizes a final normal assistant turn", () => assert.equal(isFinalNormalAssistantTurn(normal), true));
test("does not classify tool-call turns as cycle boundaries", () => assert.equal(isFinalNormalAssistantTurn({ ...normal, message: { ...normal.message, content: [{ type: "toolCall" }] } }), false));
test("accepts final responses after tool results but rejects errors and aborts", () => {
  assert.equal(isFinalNormalAssistantTurn({ ...normal, toolResults: [{}] }), true);
  assert.equal(isFinalNormalAssistantTurn({ ...normal, message: { ...normal.message, stopReason: "error" } }), false);
  assert.equal(isFinalNormalAssistantTurn({ ...normal, message: { ...normal.message, stopReason: "aborted" } }), false);
});
