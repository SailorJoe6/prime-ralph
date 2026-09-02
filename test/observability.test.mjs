import test from "node:test";
import assert from "node:assert/strict";
import { createLifecycleTracer, sanitizeLifecycleEvent, OBSERVABILITY_HOOKS } from "../src/observability.js";

test("sanitizes message and tool shapes without transcript content", () => {
  const record = sanitizeLifecycleEvent("turn_end", {
    turnIndex: 4,
    message: { role: "assistant", content: [{ type: "toolCall", name: "secret-tool" }], stopReason: "toolUse" },
    toolResults: [{ role: "toolResult", content: "private output" }],
  });
  assert.equal(record.message.hasToolCall, true);
  assert.deepEqual(record.message.contentBlockTypes, ["toolCall"]);
  assert.equal(record.toolResultCount, 1);
  assert.equal("content" in record, false);
  assert.equal(JSON.stringify(record).includes("private output"), false);
  assert.equal(JSON.stringify(record).includes("secret-tool"), false);
});

test("tracks latest persisted goal state without copying objective text", () => {
  const record = sanitizeLifecycleEvent("message_start", { message: { role: "custom", customType: "goal_context", content: "private objective" } }, {
    sessionManager: { getBranch: () => [{ type: "custom", customType: "thread_goal_state", data: { status: "active", active: true, goalId: "g1", objective: "private objective", continuationsUsed: 2 } }] },
  });
  assert.deepEqual(record.goal, { status: "active", active: true, goalId: "g1", continuationsUsed: 2 });
  assert.equal(JSON.stringify(record).includes("private objective"), false);
});

test("tracer retains sanitized records and forwards them to its sink", () => {
  const sink = [];
  const tracer = createLifecycleTracer({ sink: (entry) => sink.push(entry), now: () => 123 });
  const record = tracer.record("agent_start", {});
  assert.equal(record.timestamp, 123);
  assert.equal(tracer.records.length, 1);
  assert.deepEqual(sink, tracer.records);
});

test("exposes the researched hook set", () => {
  assert.deepEqual(OBSERVABILITY_HOOKS, ["session_start", "session_before_compact", "session_compact", "turn_start", "turn_end", "message_start", "message_end", "agent_start", "agent_end", "context"]);
});
