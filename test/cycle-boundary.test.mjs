import test from "node:test";
import assert from "node:assert/strict";
import { createQueuedToolHandoffTracker, isFinalNormalAssistantTurn, isQueuedToolHandoff } from "../src/cycle-boundary.js";

const normal = { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }, toolResults: [] };
const toolUse = (...ids) => ({ role: "assistant", stopReason: "toolUse", content: ids.map((id) => ({ type: "toolCall", id, name: "goal", arguments: {} })) });
const toolResult = (id, isError = false) => ({ type: "tool_result", toolCallId: id, toolName: "goal", input: {}, content: [], isError });
const handoffEvent = (...ids) => ({ messages: [toolUse(...ids), ...ids.map((id) => ({ role: "toolResult", toolCallId: id, toolName: "goal", content: [], isError: false }))] });
const context = (signal, pending = true) => ({ signal, hasPendingMessages: () => pending });

test("recognizes a final normal assistant turn", () => assert.equal(isFinalNormalAssistantTurn(normal), true));
test("does not classify tool-call turns as cycle boundaries", () => assert.equal(isFinalNormalAssistantTurn({ ...normal, message: { ...normal.message, content: [{ type: "toolCall" }] } }), false));
test("accepts final responses after tool results but rejects errors and aborts", () => {
  assert.equal(isFinalNormalAssistantTurn({ ...normal, toolResults: [{}] }), true);
  assert.equal(isFinalNormalAssistantTurn({ ...normal, message: { ...normal.message, stopReason: "error" } }), false);
  assert.equal(isFinalNormalAssistantTurn({ ...normal, message: { ...normal.message, stopReason: "aborted" } }), false);
});


test("recognizes only a current tool-use response with tool calls and queued host work", () => {
  const event = { messages: [toolUse("call-1")] };
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


test("retained handoff requires every successful final tool result from one request and signal", () => {
  const tracker = createQueuedToolHandoffTracker();
  tracker.beginRun();
  const run = new AbortController();
  assert.equal(tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }), true);
  assert.equal(tracker.record(toolResult("b"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }), true);
  const event = handoffEvent("a", "b");
  assert.equal(tracker.classify(event, context(undefined), { requestKey: "session:execution:start:life:1:request-1", admitted: true }), true);
});


test("retained handoff accepts the exact retained signal when the dynamic signal remains defined", () => {
  const tracker = createQueuedToolHandoffTracker();
  tracker.beginRun();
  const run = new AbortController();
  const identity = { requestKey: "session:execution:start:life:1:request-1", admitted: true };
  assert.equal(tracker.record(toolResult("a"), context(run.signal), identity), true);
  assert.equal(tracker.classify(handoffEvent("a"), context(run.signal), identity), true);
});


test("retained handoff failures stay fail closed", async (t) => {
  const cases = [
    {
      name: "actual abort after successful tool result",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); run.abort(); },
      event: handoffEvent("a"), ctx: (_run) => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "tool error",
      arrange(tracker, run) { tracker.record(toolResult("a", true), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: handoffEvent("a"), ctx: () => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "missing transcript result",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: { messages: [toolUse("a")] }, ctx: () => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "errored transcript result",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: { messages: [toolUse("a"), { role: "toolResult", toolCallId: "a", toolName: "goal", content: [], isError: true }] }, ctx: () => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "extra transcript result",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: { messages: [toolUse("a"), { role: "toolResult", toolCallId: "a", toolName: "goal", content: [], isError: false }, { role: "toolResult", toolCallId: "b", toolName: "goal", content: [], isError: false }] }, ctx: () => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "partial final batch",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: handoffEvent("a", "b"), ctx: () => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "no pending message",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: handoffEvent("a"), ctx: () => context(undefined, false), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "defined signal mismatch",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: handoffEvent("a"), ctx: () => context(new AbortController().signal), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "request mismatch",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: handoffEvent("a"), ctx: () => context(undefined), requestKey: "session:execution:start:life:2:request-2",
    },
    {
      name: "mixed run signals",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); tracker.record(toolResult("b"), context(new AbortController().signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: handoffEvent("a", "b"), ctx: () => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "callback signal failure",
      arrange(tracker) { tracker.record(toolResult("a"), { get signal() { throw new Error("lost callback context"); } }, { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: handoffEvent("a"), ctx: () => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "duplicate callback",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: handoffEvent("a"), ctx: () => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "duplicate final ID",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: { messages: [toolUse("a", "a")] }, ctx: () => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
    {
      name: "provider error after older tool use",
      arrange(tracker, run) { tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }); },
      event: { messages: [toolUse("a"), { role: "assistant", stopReason: "error", content: [] }] }, ctx: () => context(undefined), requestKey: "session:execution:start:life:1:request-1",
    },
  ];
  for (const scenario of cases) await t.test(scenario.name, () => {
    const tracker = createQueuedToolHandoffTracker();
    tracker.beginRun();
    const run = new AbortController();
    scenario.arrange(tracker, run);
    assert.equal(tracker.classify(scenario.event, scenario.ctx(run), { requestKey: scenario.requestKey, admitted: true }), false);
  });
});


test("a rejected event verdict is also stable across handler-state changes", () => {
  const tracker = createQueuedToolHandoffTracker();
  tracker.beginRun();
  const run = new AbortController();
  tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true });
  const event = handoffEvent("a");
  let reads = 0;
  const ctx = { signal: run.signal, hasPendingMessages: () => { reads += 1; return reads > 1; } };
  assert.equal(tracker.classify(event, ctx, { requestKey: "session:execution:start:life:1:request-1", admitted: true }), false);
  assert.equal(tracker.classify(event, context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }), false);
  assert.equal(reads, 1);
});


test("a new Ralph-observed run cannot reuse an older same-ID witness", () => {
  const tracker = createQueuedToolHandoffTracker();
  const run = new AbortController();
  tracker.beginRun();
  tracker.record(toolResult("same-id"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true });
  tracker.beginRun();
  assert.equal(tracker.classify(handoffEvent("same-id"), context(undefined), { requestKey: "session:execution:start:life:1:request-1", admitted: true }), false);
});


test("one event verdict is stable for both handlers and stale reuse fails closed", () => {
  const tracker = createQueuedToolHandoffTracker();
  tracker.beginRun();
  const run = new AbortController();
  tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true });
  const event = handoffEvent("a");
  let signalReads = 0, pendingReads = 0;
  const ctx = {
    get signal() { signalReads += 1; return signalReads === 1 ? run.signal : undefined; },
    hasPendingMessages() { pendingReads += 1; return pendingReads === 1; },
  };
  assert.equal(tracker.classify(event, ctx, { requestKey: "session:execution:start:life:1:request-1", admitted: true }), true);
  assert.equal(tracker.classify(event, ctx, { requestKey: "changed", admitted: false }), true);
  assert.equal(signalReads, 1); assert.equal(pendingReads, 1);
  tracker.finish(event);
  assert.equal(tracker.classify(event, context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true }), false);
});


test("reload or shutdown invalidation loses the in-memory witness", () => {
  const tracker = createQueuedToolHandoffTracker();
  tracker.beginRun();
  const run = new AbortController();
  tracker.record(toolResult("a"), context(run.signal), { requestKey: "session:execution:start:life:1:request-1", admitted: true });
  tracker.invalidate();
  assert.equal(tracker.classify(handoffEvent("a"), context(undefined), { requestKey: "session:execution:start:life:1:request-1", admitted: true }), false);
});
