import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowExtension } from "../src/workflow-extension.js";
import { PLANNING_MESSAGE_TYPE, PLANNING_STARTUP_MESSAGE_TYPE } from "../src/planning.js";
import { SPECIFICATION_MESSAGE_TYPE, STARTUP_PREPARE_MESSAGE_TYPE } from "../src/specification.js";
import { RESET_MESSAGE_TYPE } from "../src/reset-context.js";
import { executionCompactionInstructions } from "../src/execution-boundary-compaction.js";
import { armExecutionBoundaryProjection, BLOCKED_MESSAGE_TYPE, EXECUTION_MESSAGE_TYPE, EXECUTION_STATE_ENTRY_TYPE, latestExecutionState } from "../src/execution.js";

const prepare = { path: "/project/.ralph/skills/prepare/SKILL.md", text: "---\nname: prepare\ndescription: test\n---\nprepare body" };
const specSkill = { path: "/project/.ralph/skills/spec-it-out/SKILL.md", text: "---\nname: spec-it-out\ndescription: test\nprime-ralph-invocation-version: 1\n---\nspec body" };
const planSkill = { path: "/project/.ralph/skills/plan/SKILL.md", text: "---\nname: plan\ndescription: test\nprime-ralph-invocation-version: 1\n---\nplan body" };
const executeSkill = { path: "/project/.ralph/skills/execute/SKILL.md", text: "---\nname: execute\ndescription: test\nprime-ralph-invocation-version: 1\n---\nexecute body" };
const blockedSkill = { path: "/project/.ralph/skills/blocked/SKILL.md", text: "---\nname: blocked\ndescription: test\nprime-ralph-invocation-version: 1\n---\nblocked body" };
function harness({ specificationState = "absent", planState = "absent", branch = [], inspectSpecError, inspectPlanError, sendError, loadPrepareError, loadPlanError, blockedState = "absent", blockedProofState = "complete", restoredProofState = "unproven", appendFailureAt: initialAppendFailureAt, logFailureAt, sessionId = "session-1", rlmDepth = 0, sharedLogs, closeoutTimeoutMs } = {}) {
  const commands = new Map(), tools = new Map(), handlers = new Map(), sent = [], userMessages = [], notices = [], compactions = [], entries = [], logs = sharedLogs ?? [], transactions = [];
  let spec = specificationState, plan = planState, blocked = blockedState, restored = restoredProofState, blockedLifecycle = [...branch].reverse().find((entry) => entry?.data?.provenanceId)?.data.provenanceId ?? "blocked-life", nextEntry = branch.length, pending = false, idle = true, aborted = 0, appendCalls = 0, appendFailureAt = initialAppendFailureAt, logCalls = 0;
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { const values = handlers.get(name) ?? []; values.push(handler); handlers.set(name, values); },
    appendEntry(customType, data) { appendCalls += 1; if (appendCalls === appendFailureAt) throw new Error("injected state append failure"); const entry = { type: "custom", id: `e${++nextEntry}`, customType, data }; entries.push(entry); branch.push(entry); },
    sendUserMessage(message, options) { userMessages.push({ message, options }); },
    sendMessage(message, options) {
      if (sendError) throw sendError;
      sent.push({ message, options }); branch.push({ type: "custom_message", id: `e${++nextEntry}`, ...message });
    },
  };
  createWorkflowExtension({
    loadPrepare: () => { if (loadPrepareError) throw loadPrepareError; return prepare; },
    loadSpecItOut: () => specSkill,
    loadPlan: () => { if (loadPlanError) throw loadPlanError; return planSkill; },
    loadExecute: () => executeSkill,
    loadBlocked: () => blockedSkill,
    inspectSpecification: () => { if (inspectSpecError) throw inspectSpecError; return { state: spec, relativePath: ".ralph/plans/SPECIFICATION.md" }; },
    inspectPlan: () => { if (inspectPlanError) throw inspectPlanError; return { state: plan, relativePath: ".ralph/plans/EXECUTION_PLAN.md" }; },
    inspectBlocked: () => ({ state: blocked, paths: blocked === "absent" ? [] : blocked === "complete" ? [".ralph/plans/blocked/SPECIFICATION.md", ".ralph/plans/blocked/EXECUTION_PLAN.md"] : [".ralph/plans/blocked/SPECIFICATION.md"] }),
    inspectBlockedProof: () => ({ state: blockedProofState, lifecycleId: blockedLifecycle }),
    inspectRestoredProof: () => ({ state: restored, lifecycleId: blockedLifecycle, provenance: { lifecycleId: blockedLifecycle, documents: [{ bytes: 1, sha256: "a".repeat(64) }, { bytes: 1, sha256: "b".repeat(64) }] } }),
    blockDocuments: (options) => { const value = { operation: "block", lifecycleId: options.lifecycleId }; transactions.push(value); blockedLifecycle = options.lifecycleId; blocked = "complete"; spec = "absent"; plan = "absent"; return value; },
    unblockDocuments: (options) => { const value = { operation: "unblock", lifecycleId: options.lifecycleId }; transactions.push(value); blocked = "absent"; spec = "existing"; plan = "existing"; return value; },
    adoptRestoredDocuments: (options) => { const value = { operation: "adopt-restored", lifecycleId: options.lifecycleId }; transactions.push(value); restored = "unproven"; return value; },
    verifyAdoptedDocuments: (options) => { const value = { operation: "verify-adopted", lifecycleId: options.lifecycleId }; transactions.push(value); return value; },
    archiveDocuments: (options) => { const value = { operation: "archive", lifecycleId: options.lifecycleId, archiveName: options.archiveName }; transactions.push(value); spec = "absent"; plan = "absent"; return value; },
    appendLog: (value) => {
      logCalls += 1;
      if (logCalls === logFailureAt) throw new Error("injected execution log failure");
      const duplicate = logs.some((entry) => entry.sessionId === value.sessionId && entry.lifecycleId === value.lifecycleId && entry.action === value.action && entry.phase === value.phase && entry.cycle === value.cycle && entry.finalAssistantMessage === value.finalAssistantMessage);
      if (!duplicate) logs.push(value);
      return { written: !duplicate, reason: duplicate ? "duplicate" : undefined };
    },
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    createRequestId: (() => { let id = 0; return () => `id${++id}`; })(),
    ...(closeoutTimeoutMs === undefined ? {} : { closeoutTimeoutMs }),
  })(pi);
  const ctx = {
    cwd: "/project", waitForIdle: async () => {}, isIdle: () => idle,
    hasPendingMessages: () => pending, abort: () => { aborted += 1; },
    compact: (options) => compactions.push(options),
    sessionManager: { getBranch: () => branch, getHeader: () => ({ rlmDepth }), getSessionId: () => sessionId },
    ui: { notify: (...args) => notices.push(args) },
  };
  const emit = async (name, event) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  const fallback = () => compactions.at(-1).onError(new Error("Session is too short to compact"));
  const settle = async () => {
    const message = sent.at(-1)?.message;
    await emit("message_start", { message: { role: "custom", ...message } });
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  };
  return { commands, tools, handlers, sent, userMessages, notices, branch, entries, compactions, logs, transactions, ctx, emit, fallback, settle, state: () => latestExecutionState(branch, sessionId), addGoal: (data) => branch.push({ type: "custom", customType: "thread_goal_state", data }), setPending: (value) => { pending = value; }, setIdle: (value) => { idle = value; }, aborted: () => aborted, setSpecification: (value) => { spec = value; }, setPlan: (value) => { plan = value; }, setRestored: (value) => { restored = value; }, setBlocked: (value) => { blocked = value; }, failStateAppendIn: (offset) => { appendFailureAt = appendCalls + offset; }, logAttempts: () => logCalls };
}

test("registers the complete Slice 5 command and lifecycle-control surface", () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["reset", "spec-it-out", "plan", "execute"]);
  assert.deepEqual([...h.tools.keys()], ["ralph_lifecycle"]);
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

test("RLM child startup leaves the first turn to its spawn task", async () => {
  const h = harness({ specificationState: "existing", planState: "existing", rlmDepth: 1 });
  await h.emit("session_start", { reason: "startup" });
  assert.equal(h.sent.length, 0);
  assert.equal(h.branch.length, 0);
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
  assert.equal(h.commands.has("execute"), true);
  assert.equal(h.branch.some((entry) => /goal|blocked/.test(entry.customType ?? "")), false);
});

test("/plan rejects arguments and path or skill conflicts before a boundary", async () => {
  const args = harness({ specificationState: "existing" }); await assert.rejects(args.commands.get("plan").handler("x", args.ctx), /Usage/);
  for (const options of [{ specificationState: "existing", inspectPlanError: new Error("plan path conflict") }, { specificationState: "existing", loadPlanError: new Error("incompatible plan skill") }]) {
    const h = harness(options); await h.emit("session_start", { reason: "startup" });
    assert.equal(h.sent.length, 0); assert.equal(h.compactions.length, 0);
  }
});


test("complete proven blocked documents take startup precedence and partial state fails closed", async () => {
  const blocked = harness({ specificationState: "existing", blockedState: "complete" });
  await blocked.emit("session_start", { reason: "startup" });
  assert.equal(blocked.sent.length, 1); assert.equal(blocked.sent[0].message.customType, BLOCKED_MESSAGE_TYPE);
  assert.ok(blocked.sent[0].message.content.indexOf('<skill name="prepare"') < blocked.sent[0].message.content.indexOf('<skill name="blocked"'));
  await blocked.commands.get("plan").handler("", blocked.ctx); assert.match(blocked.notices.at(-1)[0], /Resolve the blocked/);
  await blocked.commands.get("execute").handler("", blocked.ctx); assert.match(blocked.notices.at(-1)[0], /unavailable while blocked/);
  const partial = harness({ blockedState: "partial" }); await partial.emit("session_start", { reason: "startup" });
  assert.equal(partial.sent.length, 0); assert.match(partial.notices[0][0], /Only one planning file/);
  const unproven = harness({ blockedState: "complete", blockedProofState: "unproven" }); await unproven.emit("session_start", { reason: "startup" });
  assert.equal(unproven.sent.length, 0); assert.match(unproven.notices[0][0], /transaction is unproven/);
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


async function startExecution(h) {
  await h.commands.get("execute").handler("", h.ctx);
  assert.equal(h.compactions.length, 1);
  h.fallback();
  await h.emit("message_start", { message: { role: "custom", ...h.sent.at(-1).message } });
  const state = h.state();
  assert.equal(state.status, "running");
  assert.equal(state.cycle, 1);
  assert.match(h.sent.at(-1).message.content, /"invocationMode":"execution-start"/);
  return state;
}
function finalEvent(text = "round finished") {
  return { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }, toolResults: [] };
}
async function control(h, params) {
  return h.tools.get("ralph_lifecycle").execute("tool", params, undefined, undefined, h.ctx);
}
async function reachReadyDriverMismatch(h) {
  const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-before-wait", status: "complete", active: false });
  const waited = await control(h, { action: "wait", lifecycleId: initial.lifecycleId, cycle: 1, reason: "review", readiness: "review finishes" });
  await h.emit("turn_end", finalEvent("waiting for review"));
  await h.emit("before_agent_start", { prompt: "review is ready" });
  h.addGoal({ goalId: "ready-driver", status: "active", active: true });
  await control(h, { action: "ready", lifecycleId: initial.lifecycleId, cycle: 1, waitId: waited.details.waitId });
  h.addGoal({ goalId: "ready-driver", status: "complete", active: false });
  await assert.rejects(control(h, { action: "wait", lifecycleId: initial.lifecycleId, cycle: 1, reason: "second review", readiness: "second review finishes" }), /already has a semantic decision/);
  await h.emit("turn_end", finalEvent("readiness accepted"));
  await h.emit("before_agent_start", { prompt: "recover the terminal ready driver" });
  h.addGoal({ goalId: "replacement-driver", status: "active", active: true });
  await h.handlers.get("context").at(-1)({ messages: [] }, h.ctx);
  assert.equal(h.state().status, "paused");
  assert.equal(h.state().pauseReason, "native goal identity changed");
  const status = await control(h, { action: "status" });
  assert.equal(status.details.readyDriverRecoveryAvailable, true);
  return initial;
}

test("/execute has exact missing-document fallbacks and admits one lifecycle", async () => {
  const missingSpec = harness(); await missingSpec.commands.get("execute").handler("", missingSpec.ctx);
  assert.match(missingSpec.notices[0][0], /SPECIFICATION\.md/); assert.equal(missingSpec.compactions.length, 0);
  const missingPlan = harness({ specificationState: "existing" }); await missingPlan.commands.get("execute").handler("", missingPlan.ctx);
  assert.match(missingPlan.notices[0][0], /EXECUTION_PLAN\.md/); assert.equal(missingPlan.compactions.length, 0);
  const h = harness({ specificationState: "existing", planState: "existing" }); const state = await startExecution(h);
  await h.commands.get("execute").handler("", h.ctx);
  assert.match(h.notices.at(-1)[0], /already running/); assert.equal(h.state().lifecycleId, state.lifecycleId); assert.equal(h.compactions.length, 1);
});

test("continue requires the native goal and admits the next clean cycle only after the explicit decision", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content });
  await assert.rejects(control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 }), /native Prime Agent goal/);
  h.addGoal({ goalId: "goal-1", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  await h.emit("turn_end", finalEvent("completed first task"));
  assert.equal(h.logs.length, 0); assert.equal(h.state().cycle, 1); assert.equal(h.state().pendingDecision.action, "continue");
  const context = h.handlers.get("context").at(-1), goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-1", continuationsUsed: 1 } };
  await h.emit("message_start", { message: goalMessage });
  const projected = await context({ messages: [{ role: "user", content: "stale" }, goalMessage] }, h.ctx);
  assert.equal(h.logs.length, 1); assert.equal(h.state().cycle, 2); assert.equal(h.state().pendingDecision, null);
  assert.equal(projected.messages.length, 1); assert.equal(projected.messages[0].customType, EXECUTION_MESSAGE_TYPE); assert.match(projected.messages[0].content, /"cycle":2/);
});


test("an admitted native continuation waits for the queued turn_end closeout", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-race", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const completed = finalEvent("completed before closeout dispatch");
  completed.message.timestamp = 1;
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-race", continuationsUsed: 1 } };
  const context = h.handlers.get("context").at(-1);

  const projection = context({ messages: [completed.message, goalMessage] }, h.ctx);
  await Promise.resolve();
  assert.equal(h.logs.length, 0); assert.equal(h.state().cycle, 1); assert.equal(h.state().pendingDecision.finalAssistantMessage, undefined);
  await h.emit("turn_end", structuredClone(completed));
  const projected = await projection;
  assert.equal(h.aborted(), 0); assert.equal(h.logs.length, 1); assert.equal(h.state().status, "running"); assert.equal(h.state().cycle, 2);
  assert.equal(projected.messages[0].customType, EXECUTION_MESSAGE_TYPE); assert.match(projected.messages[0].content, /"cycle":2/);

  await h.emit("message_start", { message: goalMessage });
  await h.emit("turn_end", finalEvent("cycle two forgot its decision"));
  assert.equal(h.aborted(), 1); assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /without a lifecycle decision/);
});


test("an RLM-split running pass re-registers closeout before the continuation reaches context", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-rlm-split", status: "active", active: true });

  // A tracked child can end the current Agent run and deliver its terminal message in a new run.
  await h.emit("agent_end", { messages: [] });
  assert.equal(h.state().status, "paused");
  await h.emit("before_agent_start", { prompt: "[from child:auditor] result" });
  assert.equal(h.state().status, "running");
  await h.emit("message_start", { message: { role: "custom", customType: "agent_message", content: "child result" } });

  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const completed = finalEvent("completed after child result"); completed.message.timestamp = 2;
  await h.emit("turn_end", completed);
  assert.equal(h.state().pendingDecision.finalAssistantMessage, "completed after child result");

  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-rlm-split", continuationsUsed: 1 } };
  await h.emit("message_start", { message: goalMessage });
  const context = h.handlers.get("context").at(-1);
  const outcome = await Promise.race([
    context({ messages: [completed.message, goalMessage] }, h.ctx),
    new Promise((resolve) => setImmediate(() => resolve("still waiting"))),
  ]);
  assert.notEqual(outcome, "still waiting");
  assert.equal(h.aborted(), 0); assert.equal(h.logs.length, 1); assert.equal(h.state().cycle, 2);
  assert.equal(outcome.messages[0].customType, EXECUTION_MESSAGE_TYPE);
});


test("a closeout that passed before waiter registration fails closed without hanging", async () => {
  const branch = [], logs = [];
  const first = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId: "missed-closeout" }); const initial = await startExecution(first);
  first.addGoal({ goalId: "goal-missed-closeout", status: "active", active: true });
  await control(first, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });

  // Reconstructing the extension loses in-memory turn tracking but keeps the durable pending decision.
  const rebuilt = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId: "missed-closeout" });
  const completed = finalEvent("untracked resumed run"); completed.message.timestamp = 3;
  await rebuilt.emit("turn_end", completed);
  assert.equal(rebuilt.state().pendingDecision.finalAssistantMessage, undefined);

  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-missed-closeout", continuationsUsed: 1 } };
  await rebuilt.emit("message_start", { message: goalMessage });
  const projected = await rebuilt.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, rebuilt.ctx);
  assert.deepEqual(projected.messages, []); assert.equal(rebuilt.aborted(), 1); assert.equal(logs.length, 0);
  assert.equal(rebuilt.state().status, "paused"); assert.match(rebuilt.state().pauseReason, /before lifecycle closeout/);
});


test("agent end releases a pending closeout waiter and leaves execution paused", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-closeout-agent-end", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const completed = finalEvent("agent ends before closeout"); completed.message.timestamp = 4;
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-closeout-agent-end", continuationsUsed: 1 } };
  await h.emit("message_start", { message: goalMessage });
  const context = h.handlers.get("context").at(-1);
  const projection = context({ messages: [completed.message, goalMessage] }, h.ctx);
  await Promise.resolve();
  await h.emit("agent_end", { messages: [] });
  const outcome = await Promise.race([projection, new Promise((resolve) => setImmediate(() => resolve("still waiting")))]);
  assert.notEqual(outcome, "still waiting"); assert.deepEqual(outcome.messages, []);
  assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /ended without normal closeout/);
});


test("agent-end append failure still releases the closeout waiter", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-agent-end-append", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const completed = finalEvent("agent-end append fails"); completed.message.timestamp = 5;
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-agent-end-append", continuationsUsed: 1 } };
  await h.emit("message_start", { message: goalMessage });
  const projection = h.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, h.ctx);
  await Promise.resolve(); h.failStateAppendIn(1);
  assert.throws(() => h.handlers.get("agent_end").at(-1)({ messages: [] }, h.ctx), /injected state append failure/);
  const outcome = await Promise.race([projection, new Promise((resolve) => setImmediate(() => resolve("still waiting")))]);
  assert.notEqual(outcome, "still waiting"); assert.deepEqual(outcome.messages, []);
  assert.equal(h.aborted(), 1); assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /before lifecycle closeout/);
});


test("session shutdown releases a pending closeout waiter", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-closeout-shutdown", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const completed = finalEvent("shutdown before closeout"); completed.message.timestamp = 6;
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-closeout-shutdown", continuationsUsed: 1 } };
  const projection = h.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, h.ctx);
  await Promise.resolve(); await h.emit("session_shutdown", { reason: "reload" });
  const outcome = await Promise.race([projection, new Promise((resolve) => setImmediate(() => resolve("still waiting")))]);
  assert.notEqual(outcome, "still waiting"); assert.deepEqual(outcome.messages, []);
  assert.equal(h.aborted(), 1); assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /before lifecycle closeout/);
});


test("an absent queued closeout times out and pauses instead of waiting forever", async () => {
  const h = harness({ specificationState: "existing", planState: "existing", closeoutTimeoutMs: 5 }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-closeout-timeout", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const completed = finalEvent("closeout never arrives"); completed.message.timestamp = 4;
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-closeout-timeout", continuationsUsed: 1 } };
  const projected = await h.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, h.ctx);
  assert.deepEqual(projected.messages, []); assert.equal(h.aborted(), 1); assert.equal(h.logs.length, 0);
  assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /before lifecycle closeout/);
});


test("reload after queued closeout preserves exact continuation admission", async () => {
  const branch = [], logs = [];
  const first = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId: "closeout-reload" });
  const initial = await startExecution(first);
  first.addGoal({ goalId: "goal-reload", status: "active", active: true });
  await control(first, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const completed = finalEvent("closeout persisted before reload");
  await first.emit("turn_end", completed);
  assert.equal(first.state().cycle, 1); assert.equal(first.state().pendingDecision.finalAssistantMessage, "closeout persisted before reload"); assert.equal(logs.length, 0);

  const rebuilt = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId: "closeout-reload" });
  await rebuilt.emit("session_start", { reason: "reload" });
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-reload", continuationsUsed: 1 } };
  const projected = await rebuilt.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, rebuilt.ctx);
  assert.equal(logs.length, 1); assert.equal(rebuilt.state().cycle, 2); assert.equal(rebuilt.state().status, "running"); assert.equal(rebuilt.state().pendingDecision, null);
  assert.equal(projected.messages[0].customType, EXECUTION_MESSAGE_TYPE); assert.match(projected.messages[0].content, /"cycle":2/);
});


test("a queued closeout state failure consumes no execution boundary", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-closeout-failure", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  h.failStateAppendIn(1);
  const completed = finalEvent("closeout cannot persist");
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-closeout-failure", continuationsUsed: 1 } };
  const projection = h.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, h.ctx);
  await h.emit("turn_end", completed);
  const projected = await projection;
  assert.deepEqual(projected.messages, []); assert.equal(h.aborted(), 1); assert.equal(h.logs.length, 0); assert.equal(h.state().cycle, 1); assert.equal(h.state().status, "paused");
  assert.match(h.state().pauseReason, /execution closeout failed/);
});


test("a continuation without the completed pass immediately before it still fails closed", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-no-closeout", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-no-closeout", continuationsUsed: 1 } };
  const projected = await h.handlers.get("context").at(-1)({ messages: [{ role: "user", content: "not a closeout" }, goalMessage] }, h.ctx);
  assert.deepEqual(projected.messages, []); assert.equal(h.aborted(), 1); assert.equal(h.logs.length, 0); assert.equal(h.state().status, "paused");
  assert.match(h.state().pauseReason, /before lifecycle closeout/);
});

test("turn end alone pauses safely and never logs or advances", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content });
  await h.emit("turn_end", finalEvent("no signal"));
  assert.equal(h.state().status, "paused"); assert.equal(h.state().cycle, 1); assert.equal(h.logs.length, 0); assert.equal(h.aborted(), 1);
});

test("waiting completes the native driver, preserves the open cycle, and resumes only with matching readiness", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content });
  h.addGoal({ goalId: "goal-1", status: "complete", active: false });
  const waited = await control(h, { action: "wait", lifecycleId: initial.lifecycleId, cycle: 1, reason: "build", readiness: "process exits" });
  const waitId = waited.details.waitId; await h.emit("turn_end", finalEvent("waiting"));
  assert.equal(h.state().status, "waiting"); assert.equal(h.state().cycle, 1); assert.equal(h.logs.length, 0);
  await h.commands.get("reset").handler("", h.ctx); assert.match(h.notices.at(-1)[0], /reset is deferred/); assert.equal(h.compactions.length, 1);
  await assert.rejects(control(h, { action: "ready", lifecycleId: initial.lifecycleId, cycle: 1, waitId: "stale" }), /current waiting identifier/);
  await h.emit("before_agent_start", { prompt: "heartbeat readiness check" });
  h.addGoal({ goalId: "goal-2", status: "active", active: true });
  await control(h, { action: "ready", lifecycleId: initial.lifecycleId, cycle: 1, waitId });
  await h.emit("turn_end", finalEvent("ready now"));
  assert.equal(h.state().status, "running"); assert.equal(h.state().cycle, 1); assert.equal(h.state().pendingDecision, null); assert.equal(h.logs.length, 0);
  const goalMessage = { role: "custom", customType: "goal_context", content: "resume", details: { kind: "continuation", goalId: "goal-2", continuationsUsed: 1 } };
  const projected = await h.handlers.get("context").at(-1)({ messages: [goalMessage] }, h.ctx);
  assert.equal(projected.messages[0].customType, EXECUTION_MESSAGE_TYPE); assert.match(projected.messages[0].content, /"cycle":1/);
});

test("recover-driver resumes one exact post-ready terminal-driver mismatch without closing the cycle", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await reachReadyDriverMismatch(h);
  const recovered = await control(h, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 });
  assert.equal(recovered.details.action, "recover-driver");
  assert.equal(h.state().status, "running");
  assert.equal(h.state().cycle, 1);
  assert.equal(h.state().lifecycleId, initial.lifecycleId);
  assert.equal(h.state().driverGoalId, "replacement-driver");
  assert.equal(h.state().resumed, true);
  assert.equal(h.state().pendingDecision.action, "recover-driver");
  await assert.rejects(control(h, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 }), /already has a semantic decision/);
  const completed = finalEvent("driver recovery complete");
  const goalMessage = { role: "custom", customType: "goal_context", content: "resume", details: { kind: "continuation", goalId: "replacement-driver", continuationsUsed: 1 } };
  const projection = h.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, h.ctx);
  await h.emit("turn_end", completed);
  const projected = await projection;
  assert.equal(h.state().cycle, 1);
  assert.equal(h.logs.length, 0);
  assert.equal(h.state().pendingDecision, null);
  assert.equal(projected.messages[0].customType, EXECUTION_MESSAGE_TYPE);
  assert.match(projected.messages[0].content, /"invocationMode":"execution-resume"/);
  assert.match(projected.messages[0].content, /"cycle":1/);
});

test("post-ready terminal-driver recovery survives reload and state-append retry", async () => {
  const branch = [];
  const first = harness({ branch, specificationState: "existing", planState: "existing", sessionId: "ready-recovery-reload" });
  const initial = await reachReadyDriverMismatch(first);
  const rebuilt = harness({ branch, specificationState: "existing", planState: "existing", sessionId: "ready-recovery-reload" });
  await rebuilt.emit("before_agent_start", { prompt: "retry recovery after reload" });
  assert.equal(rebuilt.state().transition, first.state().transition);
  rebuilt.failStateAppendIn(1);
  await assert.rejects(control(rebuilt, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 }), /injected state append failure/);
  assert.equal(rebuilt.state().status, "paused");
  assert.equal(rebuilt.state().driverGoalId, "ready-driver");
  const recovered = await control(rebuilt, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 });
  assert.equal(recovered.details.action, "recover-driver");
  assert.equal(rebuilt.state().status, "running");
  assert.equal(rebuilt.state().driverGoalId, "replacement-driver");
  assert.equal(rebuilt.state().cycle, 1);
  await rebuilt.emit("turn_end", finalEvent("recovered after reload"));
  assert.equal(rebuilt.state().status, "running");
  assert.equal(rebuilt.state().pendingDecision, null);
  assert.equal(rebuilt.state().cycle, 1);
});

test("post-ready recovery rejects a later unrelated goal and incomplete durable proof", async () => {
  const unrelated = harness({ specificationState: "existing", planState: "existing" });
  const initial = await reachReadyDriverMismatch(unrelated);
  await assert.rejects(control(unrelated, { action: "recover-driver", lifecycleId: "stale-life", cycle: 1 }), /identifier is stale or missing/);
  await assert.rejects(control(unrelated, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 2 }), /identifier is stale or missing/);
  unrelated.addGoal({ goalId: "unrelated-after-pause", status: "active", active: true });
  await assert.rejects(control(unrelated, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 }), /exact durable post-ready/);
  assert.equal(unrelated.state().status, "paused");
  assert.equal(unrelated.state().driverGoalId, "ready-driver");

  const branch = unrelated.branch.filter((entry) => entry?.data?.pendingDecision?.action !== "ready" && entry?.data?.goalId !== "unrelated-after-pause");
  const incomplete = harness({ branch, specificationState: "existing", planState: "existing" });
  await assert.rejects(control(incomplete, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 }), /exact durable post-ready/);
  assert.equal(incomplete.state().status, "paused");

  const nonterminalBranch = unrelated.branch.filter((entry) => entry?.data?.goalId !== "unrelated-after-pause").map((entry) =>
    entry?.customType === "thread_goal_state" && entry.data?.goalId === "ready-driver" && entry.data.status === "complete"
      ? { ...entry, data: { ...entry.data, status: "error" } }
      : entry);
  const nonterminal = harness({ branch: nonterminalBranch, specificationState: "existing", planState: "existing" });
  await assert.rejects(control(nonterminal, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 }), /exact durable post-ready/);
  assert.equal(nonterminal.state().status, "paused");
});

test("post-ready recovery rejects multiple replacement goals before the mismatch pause", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await reachReadyDriverMismatch(h);
  const replacementIndex = h.branch.findIndex((entry) => entry?.customType === "thread_goal_state" && entry.data?.goalId === "replacement-driver");
  h.branch.splice(replacementIndex, 0,
    { type: "custom", customType: "thread_goal_state", data: { goalId: "replacement-a", status: "active", active: true } },
    { type: "custom", customType: "thread_goal_state", data: { goalId: "replacement-a", status: "complete", active: false } });
  await assert.rejects(control(h, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 }), /exact durable post-ready/);
  assert.equal(h.state().status, "paused");
  assert.equal((await control(h, { action: "status" })).details.readyDriverRecoveryAvailable, false);
});

test("explicit /execute resumes the same lifecycle after failed recovery and terminal replacement", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await reachReadyDriverMismatch(h);
  h.failStateAppendIn(1);
  await assert.rejects(control(h, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 }), /injected state append failure/);
  await h.emit("turn_end", finalEvent("recovery failed safely"));
  await h.emit("agent_end", { messages: [finalEvent("recovery failed safely").message] });
  h.addGoal({ goalId: "replacement-driver", status: "complete", active: false });
  await h.commands.get("execute").handler("", h.ctx);
  assert.equal(h.compactions.length, 2);
  h.fallback();
  assert.equal(h.state().status, "running");
  assert.equal(h.state().lifecycleId, initial.lifecycleId);
  assert.equal(h.state().cycle, 1);
  assert.equal(h.state().driverGoalId, null);
  assert.match(h.sent.at(-1).message.content, /"invocationMode":"execution-resume"/);
});

test("reload after recovery adoption closes once and admits one unchanged-cycle resume boundary", async () => {
  const branch = [];
  const first = harness({ branch, specificationState: "existing", planState: "existing", sessionId: "adopted-reload" });
  const initial = await reachReadyDriverMismatch(first);
  await control(first, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 });
  assert.equal(first.state().pendingDecision.action, "recover-driver");

  const rebuilt = harness({ branch, specificationState: "existing", planState: "existing", sessionId: "adopted-reload" });
  await rebuilt.emit("before_agent_start", { prompt: "replacement goal continuation after reload" });
  await assert.rejects(control(rebuilt, { action: "recover-driver", lifecycleId: initial.lifecycleId, cycle: 1 }), /already has a semantic decision/);
  const completed = finalEvent("recovery turn closed after reload");
  const goalMessage = { role: "custom", customType: "goal_context", content: "resume", details: { kind: "continuation", goalId: "replacement-driver", continuationsUsed: 1 } };
  const projection = rebuilt.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, rebuilt.ctx);
  await rebuilt.emit("turn_end", completed);
  const projected = await projection;
  assert.equal(projected.messages.length, 1);
  assert.equal(projected.messages[0].customType, EXECUTION_MESSAGE_TYPE);
  assert.match(projected.messages[0].content, /"invocationMode":"execution-resume"/);
  assert.match(projected.messages[0].content, /"cycle":1/);
  assert.equal(rebuilt.state().cycle, 1);
  assert.equal(rebuilt.logs.length, 0);
  const transition = rebuilt.state().transition;
  const repeated = await rebuilt.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, rebuilt.ctx);
  assert.equal(repeated.messages.length, 1);
  assert.equal(rebuilt.state().transition, transition);
});

test("running and waiting gate interactive commands until pause", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); await startExecution(h);
  await h.commands.get("plan").handler("", h.ctx); await h.commands.get("spec-it-out").handler("", h.ctx);
  assert.match(h.notices.at(-2)[0], /Pause/); assert.match(h.notices.at(-1)[0], /Pause/);
  assert.equal(h.sent.filter((item) => [PLANNING_MESSAGE_TYPE, SPECIFICATION_MESSAGE_TYPE].includes(item.message.customType)).length, 0);
  h.addGoal({ goalId: "goal", status: "paused", active: false });
  await h.commands.get("plan").handler("", h.ctx);
  assert.equal(h.state().status, "paused");
  await h.commands.get("plan").handler("", h.ctx); assert.equal(h.sent.at(-1).message.customType, PLANNING_MESSAGE_TYPE); assert.equal(h.compactions.length, 1);
  await h.commands.get("execute").handler("", h.ctx); assert.match(h.notices.at(-1)[0], /\/goal resume/); assert.equal(h.state().status, "paused");
});

test("execution reset requests a later boundary, waiting defers, and paused reset does not trigger a turn", async () => {
  const running = harness({ specificationState: "existing", planState: "existing" }); await startExecution(running); running.setIdle(false);
  await running.commands.get("reset").handler("", running.ctx); assert.equal(running.state().resetRequested, true); assert.equal(running.compactions.length, 1); assert.equal(running.userMessages[0].options.deliverAs, "steer"); assert.match(running.userMessages[0].message, /earliest eligible boundary/);
  const pausedBranch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 2, phase: "execution", status: "paused", lifecycleId: "life", cycle: 1, driverGoalId: "goal", pendingDecision: null, wait: null, provenanceId: null, forwardConfirmed: false } }];
  const paused = harness({ branch: pausedBranch, specificationState: "existing", planState: "existing" });
  await paused.commands.get("reset").handler("", paused.ctx); assert.equal(paused.compactions.length, 1); paused.fallback();
  assert.equal(paused.sent.at(-1).options.triggerTurn, false); assert.match(paused.sent.at(-1).message.content, /execution-reset-paused/);
  await paused.commands.get("reset").handler("", paused.ctx); assert.equal(paused.compactions.length, 2);
});

test("block commits one pair transaction, logs final help, and first user response gets clean blocked context", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content }); h.addGoal({ goalId: "goal", status: "complete", active: false });
  await control(h, { action: "block", lifecycleId: initial.lifecycleId, cycle: 1, reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true });
  assert.equal(h.transactions[0].operation, "block"); assert.equal(h.state().phase, "blocked");
  await h.emit("turn_end", finalEvent("Please authenticate the provider.")); assert.equal(h.logs.length, 1);
  const before = h.handlers.get("before_agent_start").at(-1);
  const injected = await before({ prompt: "Credentials are restored" }, h.ctx);
  assert.equal(injected.message.customType, BLOCKED_MESSAGE_TYPE); assert.equal(injected.message.details.preserveTrigger, true);
  const context = h.handlers.get("context").at(-1);
  const user = { role: "user", content: "Credentials are restored" };
  const projected = await context({ messages: [{ role: "assistant", content: "stale" }, user, { role: "custom", ...injected.message }] }, h.ctx);
  assert.deepEqual(projected.messages, [{ role: "custom", ...injected.message }, user]);
});

test("terminal log failure preserves a durable closeout intent and reconstructed extension retries it", async () => {
  const sharedLogs = [];
  const h = harness({ specificationState: "existing", planState: "existing", logFailureAt: 1, sharedLogs });
  const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content });
  h.addGoal({ goalId: "goal", status: "complete", active: false });
  await control(h, { action: "block", lifecycleId: initial.lifecycleId, cycle: 1, reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true });
  await h.emit("turn_end", finalEvent("Please authenticate the provider."));
  assert.equal(h.state().phase, "blocked");
  assert.equal(h.state().pendingDecision.action, "block");
  assert.equal(h.state().pendingDecision.finalAssistantMessage, "Please authenticate the provider.");
  assert.match(h.notices.at(-1)[0], /closeout failed safely.*execution log failure/i);
  const rebuilt = harness({ branch: h.branch, blockedState: "complete", sharedLogs });
  await rebuilt.emit("session_start", { reason: "reload" });
  assert.equal(sharedLogs.length, 1);
  assert.equal(rebuilt.state().pendingDecision, null);
  assert.equal(rebuilt.sent.filter((item) => item.message.customType === BLOCKED_MESSAGE_TYPE).length, 1);
});

test("state append failure after terminal log write leaves an idempotent retry intent", async () => {
  const sharedLogs = [];
  const h = harness({ specificationState: "existing", planState: "existing", sharedLogs });
  const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content });
  h.addGoal({ goalId: "goal", status: "complete", active: false });
  await control(h, { action: "block", lifecycleId: initial.lifecycleId, cycle: 1, reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true });
  h.failStateAppendIn(2);
  await h.emit("turn_end", finalEvent("Please authenticate the provider."));
  assert.equal(sharedLogs.length, 1);
  assert.equal(h.state().pendingDecision.finalAssistantMessage, "Please authenticate the provider.");
  const rebuilt = harness({ branch: h.branch, blockedState: "complete", sharedLogs });
  await rebuilt.emit("session_start", { reason: "reload" });
  assert.equal(rebuilt.logAttempts(), 1);
  assert.equal(sharedLogs.length, 1);
  assert.equal(rebuilt.state().pendingDecision, null);
});

test("same-session unblock finishes a failed terminal log before changing lifecycle state", async () => {
  const h = harness({ specificationState: "existing", planState: "existing", logFailureAt: 1 });
  const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content });
  h.addGoal({ goalId: "goal", status: "complete", active: false });
  await control(h, { action: "block", lifecycleId: initial.lifecycleId, cycle: 1, reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true });
  await h.emit("turn_end", finalEvent("Please authenticate the provider."));
  await control(h, { action: "unblock", provenanceId: initial.lifecycleId });
  assert.equal(h.logAttempts(), 2);
  assert.equal(h.logs.length, 1);
  assert.equal(h.state().pendingDecision, null);
  assert.equal(h.transactions.at(-1).operation, "unblock");
});

test("same-session execute finishes a failed completion log before starting a new lifecycle", async () => {
  const h = harness({ specificationState: "existing", planState: "existing", logFailureAt: 1 });
  const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content });
  h.addGoal({ goalId: "goal", status: "complete", active: false });
  await control(h, { action: "complete", lifecycleId: initial.lifecycleId, cycle: 1, archive: false });
  await h.emit("turn_end", finalEvent("All requirements are complete."));
  await h.emit("agent_end", { messages: [finalEvent("All requirements are complete.").message] });
  await h.commands.get("execute").handler("", h.ctx);
  assert.equal(h.logAttempts(), 2);
  assert.equal(h.logs.length, 1);
  assert.equal(h.compactions.length, 2);
  h.fallback();
  assert.notEqual(h.state().lifecycleId, initial.lifecycleId);
});

test("textless terminal turns fail closed and cannot erase an incomplete log intent", async () => {
  const events = [finalEvent(" "), { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "hidden" }] }, toolResults: [] }];
  for (const event of events) {
    const h = harness({ specificationState: "existing", planState: "existing" });
    const initial = await startExecution(h);
    await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content });
    h.addGoal({ goalId: "goal", status: "complete", active: false });
    await control(h, { action: "block", lifecycleId: initial.lifecycleId, cycle: 1, reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true });
    await h.emit("turn_end", event);
    assert.equal(h.logs.length, 0);
    assert.equal(h.state().pendingDecision.action, "block");
    assert.match(h.notices.at(-1)[0], /has not captured a valid final assistant message/i);
    await assert.rejects(h.emit("before_agent_start", { prompt: "next turn" }), /has not captured a valid final assistant message/i);
    await assert.rejects(control(h, { action: "unblock", provenanceId: initial.lifecycleId }), /has not captured a valid final assistant message/i);
    assert.equal(h.state().pendingDecision.action, "block");
  }
});

test("unblock requires provenance and forward confirmation before a fresh explicit execute", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 2, phase: "blocked", status: "inactive", lifecycleId: "blocked-life", cycle: 1, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "blocked-life", forwardConfirmed: false, blockedContextEstablished: true } }];
  const h = harness({ branch, blockedState: "complete", specificationState: "absent", planState: "absent" });
  await control(h, { action: "unblock", provenanceId: "blocked-life" }); h.setSpecification("existing"); h.setPlan("existing");
  assert.equal(h.state().phase, "planning"); assert.equal(h.state().forwardConfirmed, false); assert.equal(h.transactions[0].operation, "unblock");
  await h.commands.get("execute").handler("", h.ctx); assert.match(h.notices.at(-1)[0], /original blocker is resolved/);
  await control(h, { action: "confirm-forward", provenanceId: "blocked-life" });
  await h.commands.get("execute").handler("", h.ctx); h.fallback(); assert.equal(h.state().status, "running"); assert.notEqual(h.state().lifecycleId, "blocked-life");
});

test("completion supports no archive and explicit named archive with no continuation", async () => {
  for (const archive of [false, true]) {
    const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
    await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content }); h.addGoal({ goalId: "goal", status: "complete", active: false });
    await control(h, { action: "complete", lifecycleId: initial.lifecycleId, cycle: 1, archive, ...(archive ? { archiveName: "release" } : {}) });
    await h.emit("turn_end", finalEvent("all requirements complete"));
    assert.equal(h.state().status, "inactive"); assert.equal(h.logs.length, 1); assert.equal(h.transactions.length, archive ? 1 : 0);
  }
});

test("native goal clear cancels the same lifecycle and reload preserves markers without replay", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal", status: "active", active: true }); await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  h.addGoal({ status: "idle", active: false }); await h.commands.get("plan").handler("", h.ctx);
  assert.equal(h.state().status, "inactive"); assert.match(h.state().cancellation, /cleared/);
  const count = h.sent.length; await h.emit("session_start", { reason: "reload" }); assert.equal(h.sent.length, count);
});

test("reload fails closed without prompts when the durable lifecycle chain is stale", async () => {
  const base = latestExecutionState([], "session-1");
  const running = { ...base, transition: 1, phase: "execution", status: "running", lifecycleId: "life", cycle: 1 };
  const record = (data) => ({ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data });
  const h = harness({ specificationState: "existing", planState: "existing", branch: [record(running), record(running)] });
  await h.emit("session_start", { reason: "reload" });
  assert.equal(h.sent.length, 0);
  assert.match(h.notices.at(-1)[0], /could not recover lifecycle state safely.*stale or duplicate/i);
});


test("a fresh lifecycle refuses an unrelated native goal and ready requires a new goal identity", async () => {
  const conflict = harness({ specificationState: "existing", planState: "existing" }); conflict.addGoal({ goalId: "other", status: "active", active: true });
  await conflict.commands.get("execute").handler("", conflict.ctx); assert.match(conflict.notices.at(-1)[0], /unrelated native Prime Agent goal/); assert.equal(conflict.compactions.length, 0);
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-1", status: "complete", active: false }); const waited = await control(h, { action: "wait", lifecycleId: initial.lifecycleId, cycle: 1, reason: "job", readiness: "done" });
  await h.emit("before_agent_start", { prompt: "waiting" }); await h.emit("turn_end", finalEvent("waiting"));
  h.addGoal({ goalId: "goal-1", status: "active", active: true });
  await assert.rejects(control(h, { action: "ready", lifecycleId: initial.lifecycleId, cycle: 1, waitId: waited.details.waitId }), /new native goal identifier/);
});

test("blocked context is marked established only when its message starts", async () => {
  const h = harness({ blockedState: "complete" }); await h.emit("session_start", { reason: "startup" });
  assert.equal(h.state().blockedContextEstablished, false);
  await h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
  assert.equal(h.state().blockedContextEstablished, true);
});


test("queued user input cannot consume or relabel a pending completed pass", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 }); await h.emit("turn_end", finalEvent("pass one final"));
  const context = h.handlers.get("context").at(-1), goalMessage = { role: "custom", customType: "goal_context", content: "old", details: { kind: "continuation", goalId: "goal" } }, user = { role: "user", content: "steer before continuing" };
  const result = await context({ messages: [{ role: "custom", customType: EXECUTION_MESSAGE_TYPE, content: "old execute", details: { source: "prime-ralph", protocolVersion: 1, lifecycleId: initial.lifecycleId } }, goalMessage, user] }, h.ctx);
  assert.equal(result, undefined); assert.equal(h.logs.length, 0); assert.equal(h.state().cycle, 1); assert.equal(h.state().pendingDecision.finalAssistantMessage, "pass one final");
  await h.emit("turn_end", finalEvent("response to steering")); assert.equal(h.logs.length, 0); assert.equal(h.state().pendingDecision.finalAssistantMessage, "pass one final");
});


test("blocked /spec-it-out protects the proven blocked specification as existing", async () => {
  const h = harness({ blockedState: "complete", specificationState: "absent" }); await h.emit("session_start", { reason: "startup" }); await h.emit("message_start", { message: { role: "custom", ...h.sent[0].message } });
  await h.commands.get("spec-it-out").handler("", h.ctx); const message = h.sent.at(-1).message;
  assert.equal(message.customType, SPECIFICATION_MESSAGE_TYPE); assert.equal(message.details.mode, "specification-existing"); assert.equal(message.details.specificationPath, ".ralph/plans/blocked/SPECIFICATION.md"); assert.match(message.content, /Do not offer future-specification creation/);
});

test("inactive and interactive planning contexts do not reapply stale execution authority", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const context = h.handlers.get("context").at(-1);
  const result = await context({ messages: [{ role: "custom", customType: EXECUTION_MESSAGE_TYPE, content: "stale execute", details: { source: "prime-ralph", protocolVersion: 1, lifecycleId: "old" } }, { role: "custom", customType: PLANNING_MESSAGE_TYPE, content: "current plan", details: { source: "prime-ralph", protocolVersion: 1 } }] }, h.ctx);
  assert.equal(result, undefined);
});


test("agent abort before a new assistant fails closed even when history ends normally", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); await startExecution(h);
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "older" }] }] });
  assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /without normal closeout/);
});


test("waiting interactive commands describe readiness or cancellation, not impossible native pause", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 3, phase: "execution", status: "waiting", lifecycleId: "life", cycle: 1, driverGoalId: "goal", pendingDecision: null, wait: { id: "wait", reason: "job", readiness: "done" }, provenanceId: null, forwardConfirmed: false } }];
  const h = harness({ branch, specificationState: "existing", planState: "existing" });
  await h.commands.get("plan").handler("", h.ctx); await h.commands.get("spec-it-out").handler("", h.ctx);
  for (const notice of h.notices) { assert.match(notice[0], /readiness or explicitly cancel/); assert.doesNotMatch(notice[0], /goal pause/); }
});


test("startup keeps an exact manually restored pair blocked and delivers one recovery interaction", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 4, phase: "blocked", status: "inactive", lifecycleId: "life", cycle: 1, driverGoalId: "goal", pendingDecision: null, wait: null, provenanceId: "life", forwardConfirmed: false, blockedContextEstablished: true, block: { reason: "credential missing", unblockCondition: "operator authenticates" } } }];
  const h = harness({ branch, specificationState: "existing", planState: "existing", blockedState: "absent", restoredProofState: "complete" }); await h.emit("session_start", { reason: "startup" });
  assert.equal(h.state().phase, "blocked"); assert.equal(h.state().status, "inactive"); assert.equal(h.state().forwardConfirmed, false); assert.equal(h.state().recovery, "active-pair-restored");
  assert.equal(h.sent[0].message.customType, BLOCKED_MESSAGE_TYPE); assert.equal(h.sent[0].message.details.invocationMode, "blocked-restored");
  assert.match(h.sent[0].message.content, /Do not move the files again/); assert.doesNotMatch(h.sent[0].message.content, /forwardConfirmed/);
});


test("same-session commands notice when the user has already moved the blocked pair", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal", status: "complete", active: false }); await control(h, { action: "block", lifecycleId: initial.lifecycleId, cycle: 1, reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true });
  await h.emit("turn_end", finalEvent("Please authenticate the provider."));
  h.setBlocked("absent"); h.setSpecification("existing"); h.setPlan("existing"); h.setRestored("complete");
  await h.commands.get("execute").handler("", h.ctx);
  assert.equal(h.state().phase, "blocked"); assert.equal(h.state().recovery, "active-pair-restored"); assert.match(h.notices.at(-1)[0], /moved back to their active folder/);
});

test("confirm-forward rejects a pair that is still in the blocked folder", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 4, phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "life", forwardConfirmed: false, blockedContextEstablished: true, blockedContextMode: "blocked" } }];
  const h = harness({ branch, blockedState: "complete", specificationState: "absent", planState: "absent" });
  await assert.rejects(control(h, { action: "confirm-forward", provenanceId: "life" }), /still in the blocked folder/); assert.equal(h.transactions.length, 0);
});

test("restored recovery gates commands with plain guidance and /reset restarts the recovery interaction", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 4, phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "life", forwardConfirmed: false, recovery: "active-pair-restored", blockedContextEstablished: true, blockedContextMode: "restored" } }];
  const h = harness({ branch, specificationState: "existing", planState: "existing", restoredProofState: "complete" });
  for (const command of ["execute", "plan", "spec-it-out"]) await h.commands.get(command).handler("", h.ctx);
  assert.equal(h.notices.length, 3); for (const [message] of h.notices) { assert.match(message, /original blocker/); assert.doesNotMatch(message, /provenance|forwardConfirmed/); }
  await h.commands.get("reset").handler("", h.ctx); h.fallback();
  const reset = h.sent.at(-1).message; assert.equal(reset.customType, RESET_MESSAGE_TYPE); assert.equal(reset.details.invocationMode, "blocked-restored"); assert.match(reset.content, /Do not move the files again/);
});

test("blocked status makes the recorded blocker and condition visible to the model", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 4, phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "life", forwardConfirmed: false, recovery: "active-pair-restored", blockedContextEstablished: true, blockedContextMode: "restored", block: { reason: "provider login is missing", unblockCondition: "provider login is restored" } } }];
  const h = harness({ branch, specificationState: "existing", planState: "existing", restoredProofState: "complete" });
  const status = await control(h, { action: "status" }), text = status.content[0].text;
  assert.match(text, /Recorded blocker: provider login is missing/); assert.match(text, /Condition required.*provider login is restored/);
});

test("confirming a manually restored pair journals adoption, removes its marker, and preserves the tool tail", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 4, phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "life", forwardConfirmed: false, recovery: "active-pair-restored", blockedContextEstablished: true, blockedContextMode: "restored" } }];
  const h = harness({ branch, specificationState: "existing", planState: "existing", restoredProofState: "complete" });
  const boundary = { role: "custom", customType: BLOCKED_MESSAGE_TYPE, content: "restored", details: { source: "prime-ralph", protocolVersion: 1, sessionId: "session-1", invocationMode: "blocked-restored", provenanceId: "life" } };
  const accepted = await control(h, { action: "confirm-forward", provenanceId: "life" });
  assert.equal(h.transactions[0].operation, "adopt-restored"); assert.equal(h.state().phase, "planning"); assert.equal(h.state().forwardConfirmed, true); assert.equal(h.state().recovery, null);
  assert.match(accepted.content[0].text, /planning files are verified/); assert.doesNotMatch(accepted.content[0].text, /provenance|forward/);
  const call = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "x", name: "ralph_lifecycle", arguments: {} }] }, result = { role: "toolResult", toolCallId: "x", content: [{ type: "text", text: "verified" }] };
  const projected = await h.handlers.get("context").at(-1)({ messages: [{ role: "user", content: "stale" }, boundary, call, result] }, h.ctx);
  assert.deepEqual(projected.messages, [boundary, call, result]);
  await h.emit("turn_end", finalEvent("Run /execute when ready."));
  assert.equal(await h.handlers.get("context").at(-1)({ messages: [boundary, call, result] }, h.ctx), undefined);
});

test("restored adoption never removes the marker when its durable intent cannot be recorded", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 4, phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "life", forwardConfirmed: false, recovery: "active-pair-restored", blockedContextEstablished: true, blockedContextMode: "restored" } }];
  const h = harness({ branch, specificationState: "existing", planState: "existing", restoredProofState: "complete", appendFailureAt: 1 });
  await assert.rejects(control(h, { action: "confirm-forward", provenanceId: "life" }), /injected state append failure/);
  assert.equal(h.transactions.length, 0); assert.equal(h.state().recovery, "active-pair-restored"); assert.equal(h.state().forwardConfirmed, false);
});

test("restored adoption recovers when final durable state append fails after marker removal", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 4, phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "life", forwardConfirmed: false, recovery: "active-pair-restored", blockedContextEstablished: true, blockedContextMode: "restored" } }];
  const h = harness({ branch, specificationState: "existing", planState: "existing", restoredProofState: "complete", appendFailureAt: 2 });
  await assert.rejects(control(h, { action: "confirm-forward", provenanceId: "life" }), /injected state append failure/);
  assert.equal(h.state().phase, "blocked"); assert.equal(h.state().recovery, "active-pair-adoption-pending"); assert.equal(h.transactions[0].operation, "adopt-restored");
  const accepted = await control(h, { action: "confirm-forward", provenanceId: "life" });
  assert.equal(h.transactions[1].operation, "verify-adopted"); assert.equal(accepted.details.state.phase, "planning"); assert.equal(h.state().forwardConfirmed, true);
});

test("startup completes an adoption whose marker was removed before final state persistence", async () => {
  const provenance = { lifecycleId: "life", documents: [{ bytes: 1, sha256: "a".repeat(64) }, { bytes: 1, sha256: "b".repeat(64) }] };
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 5, phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "life", forwardConfirmed: false, recovery: "active-pair-adoption-pending", adoption: { lifecycleId: "life", provenance }, blockedContextEstablished: true, blockedContextMode: "restored" } }];
  const h = harness({ branch, specificationState: "existing", planState: "existing", restoredProofState: "unproven" });
  await h.emit("session_start", { reason: "startup" }); assert.equal(h.transactions[0].operation, "verify-adopted"); assert.equal(h.state().phase, "planning"); assert.equal(h.state().forwardConfirmed, true); assert.equal(h.sent[0].message.customType, PLANNING_STARTUP_MESSAGE_TYPE);
});

test("reload notices a blocked pair moved to active paths and does not replay an established recovery boundary", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 4, phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "life", forwardConfirmed: false, recovery: null, blockedContextEstablished: true, blockedContextMode: "blocked" } }];
  const h = harness({ branch, specificationState: "existing", planState: "existing", restoredProofState: "complete" });
  await h.emit("session_start", { reason: "reload" }); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].message.details.invocationMode, "blocked-restored");
  await h.emit("session_start", { reason: "reload" }); assert.equal(h.sent.length, 1);
});

test("modified manually restored files fail closed with a concrete startup explanation", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 4, phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: "life", forwardConfirmed: false } }];
  const h = harness({ branch, specificationState: "existing", planState: "existing", restoredProofState: "modified" });
  await h.emit("session_start", { reason: "startup" }); assert.equal(h.sent.length, 0); assert.match(h.notices[0][0], /differ from the saved blocked versions/);
});

test("startup cancels an outstanding execution whose exact active pair disappeared", async () => {
  const branch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 2, phase: "execution", status: "running", lifecycleId: "life", cycle: 1, driverGoalId: "goal", pendingDecision: null, wait: null, provenanceId: null, forwardConfirmed: false } }];
  const h = harness({ branch, specificationState: "absent", planState: "absent" }); await h.emit("session_start", { reason: "startup" });
  assert.equal(h.state().status, "inactive"); assert.match(h.state().cancellation, /pair unavailable/); assert.equal(h.sent[0].message.customType, STARTUP_PREPARE_MESSAGE_TYPE);
});


test("one admitted continuation remains the clean boundary across steering, child notices, and tool tails", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal", status: "active", active: true }); await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 }); await h.emit("turn_end", finalEvent("pass one"));
  const stale = { role: "user", content: "pre-boundary history" };
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal", continuationsUsed: 1 } }, context = h.handlers.get("context").at(-1);
  const first = await context({ messages: [stale, goalMessage] }, h.ctx), transition = h.state().transition;
  const steering = { role: "user", content: "<btw>keep this steering</btw>" };
  const child = { role: "custom", customType: "rlm_child_result", content: "tracked child finished" };
  const call = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "x", name: "status", arguments: {} }] }, result = { role: "toolResult", toolCallId: "x", content: [{ type: "text", text: "usable output" }] };
  const second = await context({ messages: [stale, goalMessage, steering, child, call, result] }, h.ctx);
  assert.equal(h.state().transition, transition); assert.equal(second.messages[0].content, first.messages[0].content);
  assert.deepEqual(second.messages.slice(1), [steering, child, call, result]); assert.ok(!second.messages.includes(stale)); assert.equal(h.logs.length, 1);
});


test("reload reconstructs the admitted continuation boundary after newer user input", async () => {
  const branch = [], logs = [];
  const first = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId: "projection-reload" });
  const initial = await startExecution(first);
  first.addGoal({ goalId: "goal-reload-projection", status: "active", active: true });
  await control(first, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 }); await first.emit("turn_end", finalEvent("pass one"));
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-reload-projection", continuationsUsed: 1 } };
  await first.handlers.get("context").at(-1)({ messages: [{ role: "user", content: "stale" }, goalMessage] }, first.ctx);

  const rebuilt = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId: "projection-reload" });
  await rebuilt.emit("session_start", { reason: "reload" });
  const steering = { role: "user", content: "newer /btw after reload" };
  const projected = await rebuilt.handlers.get("context").at(-1)({ messages: [{ role: "user", content: "stale" }, goalMessage, steering] }, rebuilt.ctx);
  assert.equal(rebuilt.state().cycle, 2); assert.equal(rebuilt.state().admittedContinuation.identity, "goal-reload-projection:1");
  assert.equal(projected.messages[0].customType, EXECUTION_MESSAGE_TYPE); assert.match(projected.messages[0].content, /"cycle":2/);
  assert.deepEqual(projected.messages.slice(1), [steering]);
});

test("a /btw-shaped clone keeps the admitted boundary without consuming a newer continuation", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-side", status: "active", active: true }); await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 }); await h.emit("turn_end", finalEvent("pass one"));
  const firstGoal = { role: "custom", customType: "goal_context", content: "first", details: { kind: "continuation", goalId: "goal-side", continuationsUsed: 1 } }, context = h.handlers.get("context").at(-1);
  await h.emit("message_start", { message: firstGoal }); await context({ messages: [{ role: "user", content: "stale" }, firstGoal] }, h.ctx);
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 2 }); await h.emit("turn_end", finalEvent("pass two"));
  const secondGoal = { role: "custom", customType: "goal_context", content: "second", details: { kind: "continuation", goalId: "goal-side", continuationsUsed: 2 } };
  const sideQuestion = { role: "user", content: "<btw>answer without advancing</btw>" }, before = h.state().transition;
  const side = await context({ messages: [{ role: "user", content: "stale" }, firstGoal, secondGoal, sideQuestion] }, h.ctx);
  assert.equal(h.state().transition, before); assert.equal(h.state().cycle, 2); assert.equal(h.state().admittedContinuation.identity, "goal-side:1");
  assert.deepEqual(side.messages.slice(1), [sideQuestion]); assert.ok(!side.messages.some((message) => message === secondGoal || message.content === "stale"));

  const main = await context({ messages: [{ role: "user", content: "stale" }, firstGoal, secondGoal] }, h.ctx);
  assert.equal(h.state().cycle, 3); assert.equal(h.state().admittedContinuation.identity, "goal-side:2"); assert.match(main.messages[0].content, /"cycle":3/);
});



async function armedProjectionHarness({ sessionId = "projection-consumption", appendFailureAt } = {}) {
  const branch = [], logs = [];
  const first = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId });
  const initial = await startExecution(first);
  first.addGoal({ goalId: "goal-projection-consumption", status: "active", active: true });
  await control(first, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  await first.emit("turn_end", finalEvent("pass one"));
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-projection-consumption", continuationsUsed: 1 } };
  await first.handlers.get("context").at(-1)({ messages: [{ role: "user", content: "stale" }, goalMessage] }, first.ctx);
  const armed = armExecutionBoundaryProjection(first.state(), { requestId: "automatic-request" });
  branch.push({ type: "custom", id: "armed-projection", customType: EXECUTION_STATE_ENTRY_TYPE, data: armed });
  return { branch, logs, initial, goalMessage, current: harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId, appendFailureAt }) };
}

function automaticExecutionBoundary(state, overrides = {}) {
  const admitted = state.admittedContinuation;
  return { role: "custom", customType: EXECUTION_MESSAGE_TYPE, content: "execute", details: { source: "prime-ralph", protocolVersion: 1, requestId: "delivery", sessionId: state.sessionId, workflowPhase: "execution", invocationMode: admitted.mode, lifecycleId: state.lifecycleId, cycle: state.cycle, goalId: admitted.goalId, continuationsUsed: admitted.continuationsUsed, boundaryIdentity: admitted.identity, automaticCompactionRequestId: admitted.boundary.requestId, preserveTrigger: false, ...overrides } };
}

test("a steering-selected automatic boundary durably suppresses its later exact queued duplicate", async () => {
  const { branch, logs, initial, current: h } = await armedProjectionHarness();
  const summary = { role: "compactionSummary", summary: "", customInstructions: executionCompactionInstructions("automatic-request") };
  const steering = { role: "user", content: "queued steering survives" };
  await h.emit("before_agent_start", { prompt: "steering" });
  await h.emit("message_start", { message: steering });
  const projected = await h.handlers.get("context").at(-1)({ messages: [summary, steering] }, h.ctx);
  assert.equal(h.state().admittedContinuation.boundary.stage, "projection-consumed");
  assert.equal(projected.messages[0].customType, EXECUTION_MESSAGE_TYPE);
  assert.equal(projected.messages[0].details.automaticCompactionRequestId, "automatic-request");
  assert.equal(projected.messages[0].details.goalId, "goal-projection-consumption");
  assert.equal(projected.messages[0].details.continuationsUsed, 1);
  assert.deepEqual(projected.messages.slice(1), [steering]);
  assert.equal(h.compactions.length, 0);
  assert.equal(h.sent.length, 0);
  const consumedTransition = h.state().transition;
  const toolCall = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "tool-1", name: "status", arguments: {} }] };
  const toolResult = { role: "toolResult", toolCallId: "tool-1", content: [{ type: "text", text: "result" }] };
  const repeated = await h.handlers.get("context").at(-1)({ messages: [summary, steering, toolCall, toolResult] }, h.ctx);
  assert.equal(h.state().transition, consumedTransition);
  assert.equal(repeated.messages[0].details.automaticCompactionRequestId, "automatic-request");
  assert.deepEqual(repeated.messages.slice(1), [steering, toolCall, toolResult]);

  const rebuiltProjection = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId: "projection-consumption" });
  const rebuiltRepeated = await rebuiltProjection.handlers.get("context").at(-1)({ messages: [summary, steering, toolCall, toolResult] }, rebuiltProjection.ctx);
  assert.equal(rebuiltProjection.state().transition, consumedTransition);
  assert.deepEqual(rebuiltRepeated.messages.slice(1), [steering, toolCall, toolResult]);

  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 2 });
  await h.emit("turn_end", finalEvent("steered pass"));
  const abortedBefore = h.aborted(), suppressionTransition = h.state().transition;
  await h.emit("before_agent_start", { prompt: "queued boundary" });
  await h.emit("message_start", { message: projected.messages[0] });
  assert.equal(h.aborted(), abortedBefore + 1);
  await h.emit("agent_end", { messages: [] });
  assert.equal(h.state().transition, suppressionTransition);
  assert.equal(h.state().status, "running");
  assert.equal(h.state().pendingDecision.action, "continue");

  const rebuilt = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId: "projection-consumption" });
  const rebuiltTransition = rebuilt.state().transition;
  await rebuilt.emit("before_agent_start", { prompt: "queued boundary after reload" });
  await rebuilt.emit("message_start", { message: projected.messages[0] });
  assert.equal(rebuilt.aborted(), 1);
  await rebuilt.emit("agent_end", { messages: [] });
  assert.equal(rebuilt.state().transition, rebuiltTransition);
  assert.equal(rebuilt.state().status, "running");
  assert.equal(rebuilt.state().pendingDecision.action, "continue");
});

test("projection consumption append failure leaves the armed queued boundary authoritative under host hook order", async () => {
  const { current: h } = await armedProjectionHarness({ sessionId: "projection-append-failure" });
  const summary = { role: "compactionSummary", summary: "", customInstructions: executionCompactionInstructions("automatic-request") };
  const steering = { role: "user", content: "steering" };
  await h.emit("before_agent_start", { prompt: "steering" });
  await h.emit("message_start", { message: steering });
  const transition = h.state().transition;
  h.failStateAppendIn(1);
  const result = await h.handlers.get("context").at(-1)({ messages: [summary, steering] }, h.ctx);
  assert.deepEqual(result.messages, []);
  assert.equal(h.aborted(), 1);
  await h.emit("agent_end", { messages: [] });
  assert.equal(h.state().transition, transition);
  assert.equal(h.state().status, "running");
  assert.equal(h.state().admittedContinuation.boundary.stage, "armed");
  assert.match(h.notices.at(-1)[0], /could not durably record/);
});

test("post-summary near-matching execution boundaries fail closed without pausing the armed lifecycle", async () => {
  const mismatches = {
    source: "other", protocolVersion: 2, sessionId: "other-session", lifecycleId: "other-life", cycle: 3,
    goalId: "other-goal", continuationsUsed: 2, boundaryIdentity: "other-goal:2", automaticCompactionRequestId: "other-request",
  };
  for (const [field, value] of Object.entries(mismatches)) {
    const sessionId = `projection-near-match-${field}`;
    const { current: h } = await armedProjectionHarness({ sessionId });
    const summary = { role: "compactionSummary", summary: "", customInstructions: executionCompactionInstructions("automatic-request") };
    const nearMatch = automaticExecutionBoundary(h.state(), { [field]: value });
    await h.emit("before_agent_start", { prompt: `near match ${field}` });
    await h.emit("message_start", { message: nearMatch });
    const transition = h.state().transition;
    const result = await h.handlers.get("context").at(-1)({ messages: [summary, nearMatch, { role: "user", content: "steering" }] }, h.ctx);
    assert.deepEqual(result.messages, [], field);
    assert.equal(h.aborted(), 1, field);
    await h.emit("agent_end", { messages: [] });
    assert.equal(h.state().transition, transition, field);
    assert.equal(h.state().status, "running", field);
    assert.equal(h.state().admittedContinuation.boundary.stage, "armed", field);
    assert.match(h.notices.at(-1)[0], /stale or mismatched execution boundary/, field);
  }

  const { current: duplicate } = await armedProjectionHarness({ sessionId: "projection-duplicate-exact" });
  const summary = { role: "compactionSummary", summary: "", customInstructions: executionCompactionInstructions("automatic-request") };
  const exact = automaticExecutionBoundary(duplicate.state());
  await duplicate.emit("before_agent_start", { prompt: "duplicate exact boundary" });
  await duplicate.emit("message_start", { message: exact });
  const transition = duplicate.state().transition;
  const result = await duplicate.handlers.get("context").at(-1)({ messages: [summary, exact, exact] }, duplicate.ctx);
  assert.deepEqual(result.messages, []);
  await duplicate.emit("agent_end", { messages: [] });
  assert.equal(duplicate.state().transition, transition);
  assert.equal(duplicate.state().status, "running");
  assert.equal(duplicate.state().admittedContinuation.boundary.stage, "armed");
});

test("unarmed, mismatched, and already-present automatic boundaries are not consumed or suppressed", async () => {
  const { current: armed } = await armedProjectionHarness({ sessionId: "projection-mismatch" });
  const wrongSummary = { role: "compactionSummary", summary: "", customInstructions: executionCompactionInstructions("other-request") };
  assert.equal(await armed.handlers.get("context").at(-1)({ messages: [wrongSummary, { role: "user", content: "steering" }] }, armed.ctx), undefined);
  const exact = automaticExecutionBoundary(armed.state());
  const alreadyPresent = await armed.handlers.get("context").at(-1)({ messages: [{ role: "compactionSummary", summary: "", customInstructions: executionCompactionInstructions("automatic-request") }, exact, { role: "user", content: "steering" }] }, armed.ctx);
  assert.equal(armed.state().admittedContinuation.boundary.stage, "armed");
  assert.deepEqual(alreadyPresent.messages, [exact, { role: "user", content: "steering" }]);
  await armed.emit("message_start", { message: { ...exact, details: { ...exact.details, automaticCompactionRequestId: "other-request" } } });
  assert.equal(armed.aborted(), 0);

  const plain = harness({ specificationState: "existing", planState: "existing", sessionId: "projection-unarmed" });
  const initial = await startExecution(plain);
  plain.addGoal({ goalId: "goal-unarmed", status: "active", active: true });
  await control(plain, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  await plain.emit("turn_end", finalEvent("pass one"));
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-unarmed", continuationsUsed: 1 } };
  const projected = await plain.handlers.get("context").at(-1)({ messages: [goalMessage] }, plain.ctx);
  await plain.emit("message_start", { message: { ...projected.messages[0], details: { ...projected.messages[0].details, automaticCompactionRequestId: "automatic-request" } } });
  assert.equal(plain.aborted(), 0);
});

test("stale or replaced native goal continuations fail closed", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); await startExecution(h); h.addGoal({ goalId: "current", status: "active", active: true });
  const stale = { role: "custom", customType: "goal_context", content: "old", details: { kind: "continuation", goalId: "old", continuationsUsed: 4 } };
  const result = await h.handlers.get("context").at(-1)({ messages: [stale] }, h.ctx);
  assert.deepEqual(result.messages, []); assert.equal(h.state().status, "paused"); assert.equal(h.aborted(), 1);
});
