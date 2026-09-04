import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowExtension } from "../src/workflow-extension.js";
import { SPECIFICATION_MESSAGE_TYPE, STARTUP_PREPARE_MESSAGE_TYPE } from "../src/specification.js";

const prepare = { path: "/project/.ralph/skills/prepare/SKILL.md", text: "---\nname: prepare\ndescription: test\n---\nprepare body" };
const specSkill = { path: "/project/.ralph/skills/spec-it-out/SKILL.md", text: "---\nname: spec-it-out\ndescription: test\n---\nspec body" };
function harness({ state = "absent", branch = [], inspectError, sendError, loadPrepareError, sessionId = "session-1" } = {}) {
  const commands = new Map(), handlers = new Map(), sent = [], notices = [];
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { const values = handlers.get(name) ?? []; values.push(handler); handlers.set(name, values); },
    appendEntry() {},
    sendMessage(message, options) {
      if (sendError) throw sendError;
      sent.push({ message, options });
      branch.push({ type: "custom_message", ...message });
    },
  };
  createWorkflowExtension({
    loadPrepare: () => { if (loadPrepareError) throw loadPrepareError; return prepare; },
    loadSpecItOut: () => specSkill,
    inspectSpecification: () => { if (inspectError) throw inspectError; return { state, relativePath: ".ralph/plans/SPECIFICATION.md" }; },
    createRequestId: (() => { let id = 0; return () => `id${++id}`; })(),
  })(pi);
  const ctx = { cwd: "/project", waitForIdle: async () => {}, sessionManager: { getBranch: () => branch, getSessionId: () => sessionId }, ui: { notify: (...args) => notices.push(args) } };
  const emit = async (name, event) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  return { commands, handlers, sent, notices, branch, ctx, emit };
}

test("registers only the complete Slice 3 command surface", () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["reset", "spec-it-out"]);
  assert.equal(h.commands.has("plan"), false);
  assert.equal(h.commands.has("execute"), false);
});

test("delivers startup prepare once for an absent spec and suppresses reload replay", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.emit("session_start", { reason: "startup" });
  await h.emit("session_start", { reason: "reload" });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, STARTUP_PREPARE_MESSAGE_TYPE);
  assert.match(h.sent[0].message.content, /<skill name="prepare"/);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
});

test("new and resumed sessions without their own boundary receive prepare", async () => {
  for (const reason of ["new", "resume"]) {
    const h = harness({ sessionId: `session-${reason}` });
    await h.emit("session_start", { reason });
    assert.equal(h.sent.length, 1, reason);
  }
});

test("a durable current-session boundary suppresses replay across a fresh extension closure", async () => {
  const branch = [];
  const first = harness({ branch, sessionId: "same-session" });
  await first.emit("session_start", { reason: "startup" });
  const rebuilt = harness({ branch, sessionId: "same-session" });
  await rebuilt.emit("session_start", { reason: "startup" });
  assert.equal(first.sent.length, 1);
  assert.equal(rebuilt.sent.length, 0);
});

test("a synchronous startup admission failure records no false boundary", async () => {
  const h = harness({ sendError: new Error("admission failed") });
  await h.emit("session_start", { reason: "startup" });
  await h.emit("session_start", { reason: "startup" });
  assert.equal(h.sent.length, 0);
  assert.equal(h.branch.length, 0);
  assert.equal(h.notices.length, 2);
});

test("an inherited startup boundary from another session does not suppress a fork", async () => {
  const branch = [{ type: "custom_message", customType: STARTUP_PREPARE_MESSAGE_TYPE, details: { source: "prime-ralph", protocolVersion: 1, sessionId: "parent-session" } }];
  const h = harness({ branch, sessionId: "fork-session" });
  await h.emit("session_start", { reason: "fork" });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.sessionId, "fork-session");
});

test("does not deliver startup prepare when an active spec exists", async () => {
  const h = harness({ state: "existing" });
  await h.emit("session_start", { reason: "startup" });
  assert.equal(h.sent.length, 0);
});

test("startup reports inspection and skill failures without admitting a prompt", async () => {
  const conflict = harness({ inspectError: new Error("conflict") });
  await conflict.emit("session_start", { reason: "startup" });
  assert.equal(conflict.sent.length, 0); assert.match(conflict.notices[0][0], /conflict/);
  const missing = harness({ loadPrepareError: new Error("missing prepare") });
  await missing.emit("session_start", { reason: "startup" });
  assert.equal(missing.sent.length, 0); assert.match(missing.notices[0][0], /missing prepare/);
});

test("/spec-it-out preserves context and supplies authoritative absent or existing mode", async () => {
  for (const state of ["absent", "existing"]) {
    const h = harness({ state });
    await h.commands.get("spec-it-out").handler("", h.ctx);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].message.customType, SPECIFICATION_MESSAGE_TYPE);
    const mode = state === "existing" ? "specification-existing" : "specification-new";
    assert.equal(h.sent[0].message.details.mode, mode);
    assert.match(h.sent[0].message.content, new RegExp(`"invocationMode":"${mode}"`));
    assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
  }
});

test("/spec-it-out rejects arguments and state conflicts before prompt delivery", async () => {
  const args = harness();
  await assert.rejects(args.commands.get("spec-it-out").handler("later", args.ctx), /Usage/);
  assert.equal(args.sent.length, 0);
  const conflict = harness({ inspectError: new Error("path conflict") });
  await assert.rejects(conflict.commands.get("spec-it-out").handler("", conflict.ctx), /path conflict/);
  assert.equal(conflict.sent.length, 0);
});
