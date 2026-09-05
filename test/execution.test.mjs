import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCKED_MESSAGE_TYPE,
  EXECUTION_MESSAGE_TYPE,
  EXECUTION_STATE_ENTRY_TYPE,
  armExecutionBoundaryProjection,
  beginExecution,
  consumeExecutionBoundaryProjection,
  executionContextProjection,
  formatBlockedInjection,
  formatExecutionInjection,
  inactiveExecutionState,
  latestExecutionState,
  latestGoalState,
  loadBlockedSkill,
  loadExecuteSkill,
  nextExecutionState,
  reconcileGoalState,
  shouldSuppressExecutionBoundary,
} from "../src/execution.js";

function project() { const cwd = mkdtempSync(join(tmpdir(), "prime-ralph-execution-")); mkdirSync(join(cwd, ".ralph/skills/execute"), { recursive: true }); mkdirSync(join(cwd, ".ralph/skills/blocked"), { recursive: true }); return cwd; }
const skill = (name) => `---\nname: ${name}\ndescription: test\nprime-ralph-invocation-version: 1\n---\nbody`;

test("loads only versioned execute and blocked skills", () => {
  const cwd = project(); writeFileSync(join(cwd, ".ralph/skills/execute/SKILL.md"), skill("execute")); writeFileSync(join(cwd, ".ralph/skills/blocked/SKILL.md"), skill("blocked"));
  assert.equal(loadExecuteSkill({ cwd }).text, skill("execute")); assert.equal(loadBlockedSkill({ cwd }).text, skill("blocked"));
  writeFileSync(join(cwd, ".ralph/skills/execute/SKILL.md"), "---\nname: execute\ndescription: old\n---\nbody");
  assert.throws(() => loadExecuteSkill({ cwd }), /prime-ralph-invocation-version: 1/);
});

test("formats closed execution and blocked invocation metadata", () => {
  const execute = formatExecutionInjection({ path: "/x", text: skill("execute") }, { mode: "execution-continue", lifecycleId: "life", cycle: 2, driverGoalId: "goal" });
  assert.match(execute, /"skill":"execute"/); assert.match(execute, /"cycle":2/); assert.match(execute, /"driver":"prime-agent-goal"/);
  const blocked = formatBlockedInjection({ path: "/b", text: skill("blocked") }, { mode: "blocked-start", provenanceId: "proof" });
  assert.match(blocked, /"workflowPhase":"blocked"/);
  const restored = formatBlockedInjection({ path: "/b", text: skill("blocked") }, { mode: "blocked-restored", provenanceId: "proof" });
  assert.match(restored, /"workflowPhase":"planning"/); assert.match(restored, /"recovery":"active-pair-restored"/);
  assert.throws(() => formatExecutionInjection({ path: "/x", text: "x" }, { mode: "other", lifecycleId: "x", cycle: 1 }), /unknown/);
});

test("persists matching session lifecycle state and fails closed on invalid recovery", () => {
  const base = inactiveExecutionState("session-a"); const running = beginExecution(base, { lifecycleId: "life" });
  const entries = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: running }];
  assert.deepEqual(latestExecutionState(entries, "session-a"), running);
  assert.equal(latestExecutionState(entries, "session-b").status, "inactive");
  assert.throws(
    () => latestExecutionState([{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { ...running, status: "bogus" } }], "session-a"),
    /recovery stopped at an invalid state record/,
  );
});

test("recovery rejects stale and duplicate lifecycle records instead of resurrecting older state", () => {
  const base = inactiveExecutionState("session-a");
  const running = beginExecution(base, { lifecycleId: "life" });
  const waiting = nextExecutionState(running, { status: "waiting", wait: { id: "wait", reason: "job", readiness: "exit" } });
  const record = (data) => ({ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data });
  assert.deepEqual(latestExecutionState([record(running), record(waiting)], "session-a"), waiting);
  assert.throws(() => latestExecutionState([record(running), record(running)], "session-a"), /stale or duplicate state record/);
  assert.throws(() => latestExecutionState([record(waiting), record(running)], "session-a"), /stale or duplicate state record/);
  assert.deepEqual(latestExecutionState([record({ ...running, sessionId: "other" }), record(waiting)], "session-a"), waiting);
});

test("lifecycle transitions enforce identity, waiting records, and one active lifecycle", () => {
  const base = inactiveExecutionState("s"); const running = beginExecution(base, { lifecycleId: "life" });
  assert.equal(running.status, "running"); assert.equal(running.cycle, 1);
  assert.throws(() => beginExecution(running, { lifecycleId: "other" }), /cannot start/);
  assert.throws(() => nextExecutionState(running, { status: "waiting", wait: null }), /wait record/);
  const waiting = nextExecutionState(running, { status: "waiting", wait: { id: "wait", reason: "build", readiness: "exit" } });
  assert.equal(waiting.lifecycleId, running.lifecycleId);
});

test("native goal reconciliation pauses, resumes same identity, and rejects replacement", () => {
  const running = beginExecution(inactiveExecutionState("s"), { lifecycleId: "life", driverGoalId: "goal" });
  const decided = nextExecutionState(running, { pendingDecision: { action: "continue", cycle: 1, finalAssistantMessage: "done" } });
  const paused = reconcileGoalState(decided, { goalId: "goal", status: "paused" }); assert.equal(paused.status, "paused"); assert.equal(paused.pendingDecision.action, "continue");
  const resumed = reconcileGoalState(paused, { goalId: "goal", status: "active" }); assert.equal(resumed.status, "running");
  const replaced = reconcileGoalState(running, { goalId: "other", status: "active" }); assert.equal(replaced.status, "paused"); assert.match(replaced.pauseReason, /identity changed/);
});

test("reads latest native goal marker", () => {
  assert.equal(latestGoalState([]), null);
  assert.equal(latestGoalState([{ type: "custom", customType: "thread_goal_state", data: { goalId: "g", status: "active" } }]).goalId, "g");
});

test("context projection retains only latest execution boundary and optionally its trigger", () => {
  const old = { role: "user", content: "stale" }, trigger = { role: "user", content: "help" };
  const execution = { role: "custom", customType: EXECUTION_MESSAGE_TYPE, content: "skills", details: { source: "prime-ralph", protocolVersion: 1 } };
  assert.deepEqual(executionContextProjection([old, execution, { role: "assistant", content: [] }]), [execution, { role: "assistant", content: [] }]);
  const blocked = { role: "custom", customType: BLOCKED_MESSAGE_TYPE, content: "blocked", details: { source: "prime-ralph", protocolVersion: 1, preserveTrigger: true } };
  assert.deepEqual(executionContextProjection([old, trigger, blocked]), [blocked, trigger]);
});


test("blocked projection preserves the nearest triggering user rather than stale tool output", () => {
  const trigger = { role: "user", content: "fixed" }, boundary = { role: "custom", customType: BLOCKED_MESSAGE_TYPE, content: "blocked", details: { source: "prime-ralph", protocolVersion: 1, preserveTrigger: true } };
  assert.deepEqual(executionContextProjection([{ role: "assistant", content: "old" }, trigger, { role: "toolResult", content: [] }, boundary]), [boundary, trigger]);
});


test("reducer rejects forbidden phase jumps and recovery fails closed on inconsistent markers", () => {
  const base = inactiveExecutionState("s"), running = beginExecution(base, { lifecycleId: "life" });
  assert.throws(() => nextExecutionState(base, { phase: "execution", status: "paused", lifecycleId: "life", cycle: 1 }), /invalid Ralph lifecycle transition/);
  assert.throws(() => nextExecutionState(running, { phase: "blocked", status: "inactive", wait: null, provenanceId: null }), /state transition record|provenance/);
  const invalid = { ...running, phase: "planning", status: "running", transition: 99 };
  assert.throws(() => latestExecutionState([{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: invalid }], "s"), /recovery stopped at an invalid state record/);
});

test("native goal clear cancels a recorded driver and error pauses it", () => {
  const running = beginExecution(inactiveExecutionState("s"), { lifecycleId: "life", driverGoalId: "goal" });
  const cleared = reconcileGoalState(running, { status: "idle", active: false }); assert.equal(cleared.status, "inactive"); assert.match(cleared.cancellation, /cleared/);
  const failed = reconcileGoalState(running, { status: "error", active: false }); assert.equal(failed.status, "paused");
});


function admittedExecutionState() {
  const running = beginExecution(inactiveExecutionState("boundary-session"), { lifecycleId: "boundary-life", driverGoalId: "boundary-goal" });
  return nextExecutionState(running, { admittedContinuation: { identity: "boundary-goal:3", goalId: "boundary-goal", continuationsUsed: 3, cycle: 1, mode: "execution-continue" } });
}

function boundaryMessage(state, overrides = {}) {
  return {
    customType: EXECUTION_MESSAGE_TYPE,
    details: {
      source: "prime-ralph",
      protocolVersion: 1,
      sessionId: state.sessionId,
      lifecycleId: state.lifecycleId,
      cycle: state.cycle,
      goalId: state.admittedContinuation.goalId,
      continuationsUsed: state.admittedContinuation.continuationsUsed,
      boundaryIdentity: state.admittedContinuation.identity,
      automaticCompactionRequestId: state.admittedContinuation.boundary.requestId,
      ...overrides,
    },
  };
}

test("legacy admitted continuations remain valid without a boundary transaction", () => {
  const legacy = admittedExecutionState();
  const recovered = latestExecutionState([{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: legacy }], legacy.sessionId);
  assert.deepEqual(recovered.admittedContinuation, legacy.admittedContinuation);
  assert.equal(recovered.admittedContinuation.boundary, undefined);
});

test("recovery accepts the historical cycle-advance record that retained the prior boundary-less continuation", () => {
  const running = beginExecution(inactiveExecutionState("legacy-session"), { lifecycleId: "legacy-life", driverGoalId: "legacy-goal" });
  const admittedOne = nextExecutionState(running, { admittedContinuation: { identity: "legacy-goal:1", goalId: "legacy-goal", continuationsUsed: 1, cycle: 1, mode: "execution-continue" } });
  const advancedLegacy = { ...admittedOne, transition: admittedOne.transition + 1, cycle: 2 };
  const admittedTwo = { ...advancedLegacy, transition: advancedLegacy.transition + 1, admittedContinuation: { identity: "legacy-goal:2", goalId: "legacy-goal", continuationsUsed: 2, cycle: 2, mode: "execution-continue" } };
  const record = (data) => ({ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data });
  assert.deepEqual(latestExecutionState([record(running), record(admittedOne), record(advancedLegacy), record(admittedTwo)], running.sessionId), admittedTwo);
});

test("projection consumption is durable, exact, and idempotent", () => {
  const legacy = admittedExecutionState();
  const armed = armExecutionBoundaryProjection(legacy, { requestId: "boundary-request" });
  assert.equal(armed.admittedContinuation.boundary.stage, "armed");
  const message = boundaryMessage(armed);
  assert.equal(shouldSuppressExecutionBoundary(armed, message), false);

  const consumed = consumeExecutionBoundaryProjection(armed, message);
  assert.equal(consumed.admittedContinuation.boundary.stage, "projection-consumed");
  assert.equal(shouldSuppressExecutionBoundary(consumed, message), true);
  assert.equal(consumeExecutionBoundaryProjection(consumed, message), consumed);

  const record = (data) => ({ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data });
  const recovered = latestExecutionState([record(legacy), record(armed), record(consumed)], consumed.sessionId);
  assert.equal(recovered.admittedContinuation.boundary.stage, "projection-consumed");
  assert.equal(shouldSuppressExecutionBoundary(recovered, message), true);
});

test("projection suppression rejects every mismatched correlation field", () => {
  const armed = armExecutionBoundaryProjection(admittedExecutionState(), { requestId: "boundary-request" });
  const consumed = consumeExecutionBoundaryProjection(armed, boundaryMessage(armed));
  const mismatches = {
    source: "other", protocolVersion: 2, sessionId: "other-session", lifecycleId: "other-life", cycle: 2,
    goalId: "other-goal", continuationsUsed: 4, boundaryIdentity: "other-goal:4", automaticCompactionRequestId: "other-request",
  };
  for (const [key, value] of Object.entries(mismatches)) {
    const message = boundaryMessage(consumed, { [key]: value });
    assert.equal(shouldSuppressExecutionBoundary(consumed, message), false, key);
    assert.throws(() => consumeExecutionBoundaryProjection(armed, message), /stale or mismatched/, key);
  }
  assert.equal(shouldSuppressExecutionBoundary(consumed, { ...boundaryMessage(consumed), customType: "other" }), false);
});

test("execution-boundary state validation fails closed and consumption cannot roll back", () => {
  const legacy = admittedExecutionState();
  const armed = armExecutionBoundaryProjection(legacy, { requestId: "boundary-request" });
  const consumed = consumeExecutionBoundaryProjection(armed, boundaryMessage(armed));
  const record = (data) => ({ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data });
  for (const boundary of [
    { protocolVersion: 2, requestId: "boundary-request", stage: "armed" },
    { protocolVersion: 1, requestId: "", stage: "armed" },
    { protocolVersion: 1, requestId: "x".repeat(201), stage: "armed" },
    { protocolVersion: 1, requestId: "boundary-request", stage: "unknown" },
  ]) {
    const invalid = { ...armed, admittedContinuation: { ...armed.admittedContinuation, boundary } };
    assert.throws(() => latestExecutionState([record(invalid)], invalid.sessionId), /invalid state record/);
  }
  assert.throws(
    () => nextExecutionState(legacy, { admittedContinuation: { ...legacy.admittedContinuation, boundary: { protocolVersion: 1, requestId: "boundary-request", stage: "projection-consumed" } } }),
    /invalid Ralph execution-boundary state transition/,
  );
  assert.throws(
    () => nextExecutionState(consumed, { admittedContinuation: { ...consumed.admittedContinuation, boundary: { ...consumed.admittedContinuation.boundary, stage: "armed" } } }),
    /invalid Ralph execution-boundary state transition/,
  );
  assert.throws(() => nextExecutionState(consumed, { admittedContinuation: null }), /invalid Ralph execution-boundary state transition/);
  assert.throws(
    () => nextExecutionState(consumed, { admittedContinuation: { identity: "boundary-goal:4", goalId: "boundary-goal", continuationsUsed: 4, cycle: 1, mode: "execution-continue", boundary: { protocolVersion: 1, requestId: "other-request", stage: "armed" } } }),
    /invalid Ralph execution-boundary state transition/,
  );
  assert.throws(
    () => nextExecutionState(consumed, { admittedContinuation: { ...consumed.admittedContinuation, boundary: { ...consumed.admittedContinuation.boundary, requestId: "other-request" } } }),
    /invalid Ralph execution-boundary state transition/,
  );
  const advanced = nextExecutionState(consumed, { cycle: 2, admittedContinuation: null });
  assert.equal(advanced.cycle, 2); assert.equal(advanced.admittedContinuation, null);
  const nextArmedContinuation = { identity: "boundary-goal:4", goalId: "boundary-goal", continuationsUsed: 4, cycle: 2, mode: "execution-continue", boundary: { protocolVersion: 1, requestId: "next-request", stage: "armed" } };
  assert.equal(nextExecutionState(consumed, { cycle: 2, admittedContinuation: nextArmedContinuation }).admittedContinuation.boundary.stage, "armed");
  const nextConsumedContinuation = { ...nextArmedContinuation, boundary: { ...nextArmedContinuation.boundary, stage: "projection-consumed" } };
  assert.throws(() => nextExecutionState(consumed, { cycle: 2, admittedContinuation: nextConsumedContinuation }), /invalid Ralph execution-boundary state transition/);
  assert.throws(() => nextExecutionState(consumed, { lifecycleId: "other-life", cycle: 1, admittedContinuation: { ...nextConsumedContinuation, cycle: 1 } }), /invalid Ralph execution-boundary state transition/);

  for (const admittedContinuation of [
    { ...consumed.admittedContinuation, boundary: { ...consumed.admittedContinuation.boundary, stage: "armed" } },
    null,
    { identity: "boundary-goal:4", goalId: "boundary-goal", continuationsUsed: 4, cycle: 1, mode: "execution-continue", boundary: { protocolVersion: 1, requestId: "other-request", stage: "armed" } },
  ]) {
    const rollback = { ...consumed, transition: consumed.transition + 1, admittedContinuation };
    assert.throws(() => latestExecutionState([record(consumed), record(rollback)], consumed.sessionId), /invalid execution-boundary transition/);
  }
  const directConsumedCycle = { ...consumed, transition: consumed.transition + 1, cycle: 2, admittedContinuation: nextConsumedContinuation };
  const directConsumedLifecycle = { ...consumed, transition: consumed.transition + 1, lifecycleId: "other-life", admittedContinuation: { ...nextConsumedContinuation, cycle: 1 } };
  assert.throws(() => latestExecutionState([record(consumed), record(directConsumedCycle)], consumed.sessionId), /invalid execution-boundary transition/);
  assert.throws(() => latestExecutionState([record(consumed), record(directConsumedLifecycle)], consumed.sessionId), /invalid execution-boundary transition/);
  assert.deepEqual(latestExecutionState([record(directConsumedCycle)], consumed.sessionId), directConsumedCycle);
});

test("arming is single-owner and requires the current admitted continuation", () => {
  const legacy = admittedExecutionState();
  const armed = armExecutionBoundaryProjection(legacy, { requestId: "boundary-request" });
  assert.equal(armExecutionBoundaryProjection(armed, { requestId: "boundary-request" }), armed);
  assert.throws(() => armExecutionBoundaryProjection(armed, { requestId: "other-request" }), /different boundary request/);
  assert.throws(() => armExecutionBoundaryProjection(beginExecution(inactiveExecutionState("s"), { lifecycleId: "life" }), { requestId: "request" }), /active admitted execution continuation/);
  assert.throws(() => armExecutionBoundaryProjection(legacy, { requestId: "" }), /1 to 200 characters/);
  assert.throws(() => armExecutionBoundaryProjection(legacy, { requestId: "x".repeat(201) }), /1 to 200 characters/);
});
