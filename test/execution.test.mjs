import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCKED_MESSAGE_TYPE,
  blockedContextBoundary,
  EXECUTION_MESSAGE_TYPE,
  EXECUTION_STATE_ENTRY_TYPE,
  admitPendingExecutionRound,
  armPendingExecutionRound,
  beginExecution,
  formatBlockedInjection,
  formatExecutionInjection,
  inactiveExecutionState,
  latestExecutionState,
  latestGoalState,
  loadBlockedSkill,
  loadExecuteSkill,
  nextExecutionState,
  reconcileGoalState,
  updatePendingExecutionRound,
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

test("pending execution rounds progress from durable arm to post-compaction admission only", () => {
  const running = beginExecution(inactiveExecutionState("s"), { lifecycleId: "life", driverGoalId: "goal" });
  const closed = nextExecutionState(running, { pendingDecision: { action: "continue", cycle: 1, finalAssistantMessage: "done", timestamp: "2026-09-06T00:00:00.000Z" } });
  const armed = armPendingExecutionRound(closed, { requestId: "request", goalId: "goal", continuationsUsed: 1 });
  assert.equal(armed.cycle, 1); assert.equal(armed.pendingDecision, null); assert.equal(armed.pendingRound.cycle, 2); assert.equal(armed.pendingRound.stage, "armed");
  assert.throws(() => updatePendingExecutionRound(armed, { stage: "admission-requested", markerId: "marker" }), /invalid Ralph execution-boundary/);
  const compacting = updatePendingExecutionRound(armed, { stage: "compacting", markerId: "marker" });
  const requested = updatePendingExecutionRound(compacting, { stage: "admission-requested" });
  const admitted = admitPendingExecutionRound(requested);
  assert.equal(admitted.cycle, 2); assert.equal(admitted.pendingRound, null); assert.equal(admitted.admittedContinuation.identity, "goal:1");
  assert.equal(admitted.admittedContinuation.automaticCompactionRequestId, "request");
  assert.throws(() => admitPendingExecutionRound(compacting), /not ready/);
  const failed = nextExecutionState(compacting, { status: "paused", compactionHalted: true, resumeBlocked: true, pauseReason: "failed", pendingRound: { ...compacting.pendingRound, stage: "failed", outcome: "failed" } });
  assert.equal(reconcileGoalState(failed, { goalId: "goal", status: "active" }), failed);
  const cleared = reconcileGoalState(failed, { goalId: "goal", status: "idle" });
  assert.equal(cleared.status, "inactive"); assert.equal(cleared.phase, "planning"); assert.equal(cleared.pendingRound, null);
  assert.equal(cleared.compactionHalted, false); assert.equal(cleared.resumeBlocked, false);
});

test("native goal reconciliation pauses, resumes same identity, and rejects replacement", () => {
  const running = beginExecution(inactiveExecutionState("s"), { lifecycleId: "life", driverGoalId: "goal" });
  const decided = nextExecutionState(running, { pendingDecision: { action: "continue", cycle: 1, finalAssistantMessage: "done" } });
  const paused = reconcileGoalState(decided, { goalId: "goal", status: "paused" }); assert.equal(paused.status, "paused"); assert.equal(paused.pendingDecision.action, "continue");
  const resumed = reconcileGoalState(paused, { goalId: "goal", status: "active" }); assert.equal(resumed.status, "running"); assert.equal(resumed.resumed, false);
  assert.equal(resumed.pendingDecision.action, "continue");
  const replaced = reconcileGoalState(running, { goalId: "other", status: "active" }); assert.equal(replaced.status, "paused"); assert.match(replaced.pauseReason, /identity changed/);
  assert.equal(reconcileGoalState(replaced, { goalId: "other", status: "active" }), replaced);
});

test("reads latest native goal marker", () => {
  assert.equal(latestGoalState([]), null);
  assert.equal(latestGoalState([{ type: "custom", customType: "thread_goal_state", data: { goalId: "g", status: "active" } }]).goalId, "g");
});

test("blocked projection preserves the nearest triggering user rather than stale tool output", () => {
  const trigger = { role: "user", content: "fixed" }, boundary = { role: "custom", customType: BLOCKED_MESSAGE_TYPE, content: "blocked", details: { source: "prime-ralph", protocolVersion: 1, preserveTrigger: true } };
  assert.deepEqual(blockedContextBoundary([{ role: "assistant", content: "old" }, trigger, { role: "toolResult", content: [] }, boundary]), [boundary, trigger]);
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

test("historical projection-consumed records remain recoverable but cannot be produced by runtime code", () => {
  const legacy = admittedExecutionState();
  const armed = nextExecutionState(legacy, { admittedContinuation: { ...legacy.admittedContinuation, boundary: { protocolVersion: 1, requestId: "legacy-request", stage: "armed" } } });
  const consumed = nextExecutionState(armed, { admittedContinuation: { ...armed.admittedContinuation, boundary: { ...armed.admittedContinuation.boundary, stage: "projection-consumed" } } });
  const record = (data) => ({ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data });
  assert.equal(latestExecutionState([record(legacy), record(armed), record(consumed)], consumed.sessionId).admittedContinuation.boundary.stage, "projection-consumed");
  assert.throws(() => nextExecutionState(consumed, { admittedContinuation: { ...consumed.admittedContinuation, boundary: { ...consumed.admittedContinuation.boundary, stage: "armed" } } }), /invalid Ralph execution-boundary/);
  assert.throws(() => nextExecutionState(consumed, { admittedContinuation: null }), /invalid Ralph execution-boundary/);
});
