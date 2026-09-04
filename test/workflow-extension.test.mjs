import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowExtension } from "../src/workflow-extension.js";
import { PLANNING_MESSAGE_TYPE, PLANNING_STARTUP_MESSAGE_TYPE } from "../src/planning.js";
import { SPECIFICATION_MESSAGE_TYPE, STARTUP_PREPARE_MESSAGE_TYPE } from "../src/specification.js";
import { RESET_MESSAGE_TYPE } from "../src/reset-context.js";

const prepare = { path: "/project/.ralph/skills/prepare/SKILL.md", text: "---\nname: prepare\ndescription: test\n---\nprepare body" };
const specSkill = { path: "/project/.ralph/skills/spec-it-out/SKILL.md", text: "---\nname: spec-it-out\ndescription: test\nprime-ralph-invocation-version: 1\n---\nspec body" };
const planSkill = { path: "/project/.ralph/skills/plan/SKILL.md", text: "---\nname: plan\ndescription: test\nprime-ralph-invocation-version: 1\n---\nplan body" };
function harness({ specificationState = "absent", planState = "absent", branch = [], inspectSpecError, inspectPlanError, sendError, loadPrepareError, loadPlanError, blockedState = "absent", sessionId = "session-1" } = {}) {
  const commands = new Map(), handlers = new Map(), sent = [], notices = [], compactions = [], entries = [];
  let spec = specificationState, plan = planState, nextEntry = branch.length;
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { const values = handlers.get(name) ?? []; values.push(handler); handlers.set(name, values); },
    appendEntry(customType, data) { const entry = { type: "custom", id: `e${++nextEntry}`, customType, data }; entries.push(entry); branch.push(entry); },
    sendMessage(message, options) {
      if (sendError) throw sendError;
      sent.push({ message, options }); branch.push({ type: "custom_message", id: `e${++nextEntry}`, ...message });
    },
  };
  createWorkflowExtension({
    loadPrepare: () => { if (loadPrepareError) throw loadPrepareError; return prepare; },
    loadSpecItOut: () => specSkill,
    loadPlan: () => { if (loadPlanError) throw loadPlanError; return planSkill; },
    inspectSpecification: () => { if (inspectSpecError) throw inspectSpecError; return { state: spec, relativePath: ".ralph/plans/SPECIFICATION.md" }; },
    inspectPlan: () => { if (inspectPlanError) throw inspectPlanError; return { state: plan, relativePath: ".ralph/plans/EXECUTION_PLAN.md" }; },
    inspectBlocked: () => ({ state: blockedState, paths: blockedState === "absent" ? [] : [".ralph/plans/blocked/SPECIFICATION.md"] }),
    createRequestId: (() => { let id = 0; return () => `id${++id}`; })(),
  })(pi);
  const ctx = {
    cwd: "/project", waitForIdle: async () => {},
    compact: (options) => compactions.push(options),
    sessionManager: { getBranch: () => branch, getSessionId: () => sessionId },
    ui: { notify: (...args) => notices.push(args) },
  };
  const emit = async (name, event) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  const fallback = () => compactions.at(-1).onError(new Error("Session is too short to compact"));
  const settle = async () => {
    const message = sent.at(-1)?.message;
    await emit("message_start", { message: { role: "custom", ...message } });
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  };
  return { commands, handlers, sent, notices, branch, entries, compactions, ctx, emit, fallback, settle, setSpecification: (value) => { spec = value; }, setPlan: (value) => { plan = value; } };
}

test("registers only the complete Slice 4 command surface", () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["reset", "spec-it-out", "plan"]);
  assert.equal(h.commands.has("execute"), false);
});

test("delivers no-spec startup prepare once and suppresses reload replay", async () => {
  const h = harness();
  await h.emit("session_start", { reason: "startup" });
  await h.emit("session_start", { reason: "startup" });
  await h.emit("session_start", { reason: "reload" });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, STARTUP_PREPARE_MESSAGE_TYPE);
  assert.match(h.sent[0].message.content, /<skill name="prepare"/);
});

test("new and resumed no-spec sessions each receive their own prepare boundary", async () => {
  for (const reason of ["new", "resume"]) {
    const h = harness({ sessionId: `session-${reason}` });
    await h.emit("session_start", { reason }); assert.equal(h.sent.length, 1, reason);
  }
});

test("durable startup boundaries suppress only the matching session", async () => {
  const branch = [];
  const first = harness({ branch, sessionId: "same-session" }); await first.emit("session_start", { reason: "startup" });
  const rebuilt = harness({ branch, sessionId: "same-session" }); await rebuilt.emit("session_start", { reason: "startup" });
  const fork = harness({ branch, sessionId: "fork-session" }); await fork.emit("session_start", { reason: "fork" });
  assert.equal(first.sent.length, 1); assert.equal(rebuilt.sent.length, 0); assert.equal(fork.sent.length, 1);
});

test("active-spec startup enters planning with ordered prepare then plan for either plan state", async () => {
  for (const planState of ["absent", "existing"]) {
    const h = harness({ specificationState: "existing", planState });
    await h.emit("session_start", { reason: "startup" });
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].message.customType, PLANNING_STARTUP_MESSAGE_TYPE);
    const content = h.sent[0].message.content;
    assert.ok(content.indexOf('<skill name="prepare"') < content.indexOf('<skill name="plan"'));
    assert.match(content, new RegExp(`"invocationMode":"planning-${planState === "existing" ? "existing" : "new"}"`));
    assert.equal(h.sent[0].message.details.workflowPhase, "planning");
  }
});

test("startup failures admit no partial prompt or durable false boundary", async () => {
  for (const options of [{ inspectSpecError: new Error("spec conflict") }, { specificationState: "existing", inspectPlanError: new Error("plan conflict") }, { specificationState: "existing", loadPlanError: new Error("bad plan skill") }, { loadPrepareError: new Error("missing prepare") }, { sendError: new Error("admission") }]) {
    const h = harness(options); await h.emit("session_start", { reason: "startup" });
    assert.equal(h.sent.length, 0); assert.equal(h.branch.length, 0); assert.equal(h.notices.length, 1);
  }
});

test("/spec-it-out preserves context and supplies authoritative absent or existing mode", async () => {
  for (const specificationState of ["absent", "existing"]) {
    const h = harness({ specificationState });
    await h.commands.get("spec-it-out").handler("", h.ctx);
    assert.equal(h.sent[0].message.customType, SPECIFICATION_MESSAGE_TYPE);
    const mode = specificationState === "existing" ? "specification-existing" : "specification-new";
    assert.match(h.sent[0].message.content, new RegExp(`"invocationMode":"${mode}"`));
    assert.equal(h.compactions.length, 0);
  }
});

test("/spec-it-out rejects arguments and state conflicts before delivery", async () => {
  const args = harness(); await assert.rejects(args.commands.get("spec-it-out").handler("later", args.ctx), /Usage/);
  const conflict = harness({ inspectSpecError: new Error("path conflict") }); await assert.rejects(conflict.commands.get("spec-it-out").handler("", conflict.ctx), /path conflict/);
  assert.equal(args.sent.length + conflict.sent.length, 0);
});

test("/plan has a descriptive missing-spec fallback with no mutation", async () => {
  const h = harness(); await h.commands.get("plan").handler("", h.ctx);
  assert.equal(h.sent.length, 0); assert.equal(h.compactions.length, 0); assert.equal(h.entries.length, 0);
  assert.match(h.notices[0][0], /requires an active specification/);
});

test("explicit /plan from specification phase uses one clean prepare-plan boundary", async () => {
  const h = harness(); await h.emit("session_start", { reason: "startup" });
  h.setSpecification("existing");
  await h.commands.get("plan").handler("", h.ctx);
  assert.equal(h.compactions.length, 1); assert.equal(h.sent.length, 1);
  h.fallback();
  const message = h.sent.at(-1).message;
  assert.equal(message.customType, RESET_MESSAGE_TYPE);
  assert.equal(message.details.workflowPhase, "planning");
  assert.match(message.content, /"invocationMode":"planning-new"/);
  assert.ok(message.content.indexOf('<skill name="prepare"') < message.content.indexOf('<skill name="plan"'));
});

test("existing-plan /plan is current-context only after planning is established", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  await h.emit("session_start", { reason: "startup" });
  await h.commands.get("plan").handler("", h.ctx);
  assert.equal(h.compactions.length, 0); assert.equal(h.sent.at(-1).message.customType, PLANNING_MESSAGE_TYPE);
  assert.match(h.sent.at(-1).message.content, /"invocationMode":"planning-existing"/);
  assert.doesNotMatch(h.sent.at(-1).message.content, /<skill name="prepare"/);
});

test("phase survives reload and distinguishes specification reset from planning reset", async () => {
  const branch = [];
  const first = harness({ branch, specificationState: "absent", planState: "absent", sessionId: "phase-session" });
  await first.emit("session_start", { reason: "startup" }); first.setSpecification("existing");
  await first.commands.get("reset").handler("", first.ctx); first.fallback();
  assert.match(first.sent.at(-1).message.content, /"invocationMode":"specification-reset-existing"/);
  await first.settle();
  await first.commands.get("plan").handler("", first.ctx); first.fallback(); await first.settle();
  const rebuilt = harness({ branch, specificationState: "existing", planState: "absent", sessionId: "phase-session" });
  await rebuilt.emit("session_start", { reason: "reload" });
  await rebuilt.commands.get("reset").handler("", rebuilt.ctx); rebuilt.fallback();
  assert.match(rebuilt.sent.at(-1).message.content, /"invocationMode":"planning-reset-new"/);
  assert.doesNotMatch(rebuilt.sent.at(-1).message.content, /<skill name="spec-it-out"/);
});

test("planning reset with an existing plan stays clean and never starts execution", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); await h.emit("session_start", { reason: "startup" });
  await h.commands.get("reset").handler("", h.ctx); h.fallback();
  assert.match(h.sent.at(-1).message.content, /"invocationMode":"planning-reset-existing"/);
  assert.equal(h.commands.has("execute"), false);
  assert.equal(h.branch.some((entry) => /execute|goal|blocked/.test(entry.customType ?? "")), false);
});

test("/plan rejects arguments and path or skill conflicts before a boundary", async () => {
  const args = harness({ specificationState: "existing" }); await assert.rejects(args.commands.get("plan").handler("x", args.ctx), /Usage/);
  for (const options of [{ specificationState: "existing", inspectPlanError: new Error("plan path conflict") }, { specificationState: "existing", loadPlanError: new Error("incompatible plan skill") }]) {
    const h = harness(options); await h.emit("session_start", { reason: "startup" });
    assert.equal(h.sent.length, 0); assert.equal(h.compactions.length, 0);
  }
});


test("blocked planning documents gate startup and interactive commands until Slice 5", async () => {
  const h = harness({ specificationState: "existing", blockedState: "complete" });
  await h.emit("session_start", { reason: "startup" });
  assert.equal(h.sent.length, 0); assert.match(h.notices[0][0], /blocked handling is not available/);
  await assert.rejects(h.commands.get("spec-it-out").handler("", h.ctx), /blocked handling is not available/);
  await assert.rejects(h.commands.get("plan").handler("", h.ctx), /blocked handling is not available/);
  await assert.rejects(h.commands.get("reset").handler("", h.ctx), /blocked handling is not available/);
  assert.equal(h.compactions.length, 0); assert.equal(h.entries.length, 0);
});


test("same-session resume preserves specification phase after a spec appears", async () => {
  const branch = [];
  const first = harness({ branch, specificationState: "absent", sessionId: "resume-phase" });
  await first.emit("session_start", { reason: "startup" });
  const resumed = harness({ branch, specificationState: "existing", planState: "absent", sessionId: "resume-phase" });
  await resumed.emit("session_start", { reason: "resume" });
  assert.equal(resumed.sent.length, 0);
  await resumed.commands.get("reset").handler("", resumed.ctx); resumed.fallback();
  assert.match(resumed.sent.at(-1).message.content, /"invocationMode":"specification-reset-existing"/);
  assert.doesNotMatch(resumed.sent.at(-1).message.content, /<skill name="plan"/);
});
