import test from "node:test";
import assert from "node:assert/strict";
import { inactiveExecutionState } from "../src/execution.js";
import { RESET_COMPACTION_INSTRUCTION_PREFIX, RESET_MARKER_TYPE, RESET_MESSAGE_TYPE, RESET_PROTOCOL_VERSION, RESET_STATE_TYPE } from "../src/reset-context.js";
import { RECOVERY_PROTOCOL_VERSION, RECOVERY_STATE_TYPE, RalphRecoveryError, branchForLeaf, findPoisonedRecoveryCandidate, planRalphRecovery, recoveryRecord } from "../src/recovery.js";

function builder(sessionId = "session-1") {
  const entries = []; let parentId = null, n = 0;
  const add = (entry) => { const value = { id: `e${++n}`, parentId, timestamp: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`, ...entry }; entries.push(value); parentId = value.id; return value; };
  const anchor = add({ type: "custom", customType: "fixture_anchor", data: {} });
  const bundle = ({ requestId, command, workflowPhase, lifecycleId = null, cycle = null, provenanceId = null, invocationMode: requestedMode = null, terminal = "failed" }) => {
    const invocationMode = requestedMode ?? (command === "execute" ? "execution-start" : command === "execute-round" ? "execution-continue" : command === "plan" ? "planning-new" : `${workflowPhase}-reset`);
    const identity = { workflowPhase, invocationMode, sessionId, ...(lifecycleId ? { lifecycleId, cycle } : {}), ...(provenanceId ? { provenanceId } : {}) };
    const marker = add({ type: "custom", customType: RESET_MARKER_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command, ...identity } });
    add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: "compacting", markerId: marker.id, command, ...identity } });
    add({ type: "compaction", summary: "", firstKeptEntryId: marker.id, tokensBefore: 50, customInstructions: `${RESET_COMPACTION_INSTRUCTION_PREFIX}${requestId}`, details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command, ...identity } });
    add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: "prepare_pending", mode: "compaction", command, ...identity } });
    const message = add({ type: "custom_message", customType: RESET_MESSAGE_TYPE, content: "skills", display: false, details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command, ...identity } });
    if (lifecycleId) add({ type: "custom", customType: "prime_ralph_execution_state", data: { source: "prime-ralph", protocolVersion: 1, sessionId, transition: n, phase: "execution", status: "running", lifecycleId, cycle, driverGoalId: "goal", pendingDecision: null, wait: null, provenanceId: null, forwardConfirmed: false } });
    add({ type: "message", message: { role: "assistant", stopReason: terminal === "completed" ? "stop" : "toolUse", content: terminal === "completed" ? [{ type: "text", text: "ready" }] : [{ type: "toolCall", id: "c", name: "goal", arguments: {} }] } });
    const terminalEntry = add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: terminal, command, ...(terminal === "failed" ? { reason: "missing_normal_turn_end", boundaryExists: true } : {}), ...identity } });
    return { marker, message, terminalEntry };
  };
  return { entries, anchor, add, bundle, leaf: () => entries.at(-1).id, branch: () => branchForLeaf(entries, entries.at(-1).id), setParent: (id) => { parentId = id; } };
}

test("planning poison selects the exact poisoned marker parent", () => {
  const h = builder(); const poison = h.bundle({ requestId: "plan-reset", command: "plan", workflowPhase: "planning" });
  const candidate = findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1");
  assert.deepEqual(candidate, { requestId: "plan-reset", rootRequestId: "plan-reset", command: "plan", workflowPhase: "planning", lifecycleId: null, cycle: null, poisonedMarkerId: poison.marker.id, rootMarkerId: poison.marker.id, anchorId: h.anchor.id });
  assert.equal(planRalphRecovery({ branch: h.branch(), entries: h.entries, sessionId: "session-1", leafId: h.leaf() }).kind, "navigate");
});

test("later execution poison selects the initial execute marker parent", () => {
  const h = builder(); const root = h.bundle({ requestId: "execute-root", command: "execute", workflowPhase: "execution", lifecycleId: "life", cycle: 1, terminal: "failed" });
  const poison = h.bundle({ requestId: "execute-round", command: "execute-round", workflowPhase: "execution", lifecycleId: "life", cycle: 2 });
  const candidate = findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1");
  assert.equal(candidate.requestId, "execute-round"); assert.equal(candidate.rootRequestId, "execute-root");
  assert.equal(candidate.poisonedMarkerId, poison.marker.id); assert.equal(candidate.rootMarkerId, root.marker.id); assert.equal(candidate.anchorId, h.anchor.id);
});

test("a later unavailable reset attempt does not obscure the provider-visible poison", () => {
  const h = builder(); h.bundle({ requestId: "poison", command: "execute", workflowPhase: "execution", lifecycleId: "life", cycle: 1 });
  h.add({ type: "custom", customType: RESET_MARKER_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: "unavailable", command: "reset" } });
  h.add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: "unavailable", status: "failed", command: "reset", reason: "compaction_unavailable" } });
  assert.equal(findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1").requestId, "poison");
});

test("legacy v2 execution poison remains recoverable through exact lifecycle evidence", () => {
  const h = builder(); h.bundle({ requestId: "legacy", command: "execute", workflowPhase: "execution", lifecycleId: "legacy-life", cycle: 1 });
  for (const entry of h.entries) {
    const evidence = entry.type === "custom_message" ? entry.details : entry.type === "compaction" ? entry.details : entry.data;
    if (evidence?.requestId !== "legacy") continue;
    evidence.protocolVersion = 2;
    if (entry.type !== "custom_message") for (const field of ["workflowPhase", "invocationMode", "sessionId", "lifecycleId", "cycle", "provenanceId"]) delete evidence[field];
    if (entry.type === "compaction") entry.customInstructions = "prime-ralph-reset:v2:legacy";
  }
  const candidate = findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1");
  assert.equal(candidate.lifecycleId, "legacy-life"); assert.equal(candidate.anchorId, h.anchor.id);
});

test("post-navigation crash stages resume deterministically", () => {
  const h = builder(); h.bundle({ requestId: "poison", command: "execute", workflowPhase: "execution", lifecycleId: "life", cycle: 1 });
  const priorLeafId = h.leaf(), candidate = findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1");
  h.setParent(candidate.anchorId);
  let active = branchForLeaf(h.entries, candidate.anchorId);
  let plan = planRalphRecovery({ branch: active, entries: h.entries, sessionId: "session-1", leafId: candidate.anchorId });
  assert.equal(plan.kind, "append-provenance"); assert.equal(plan.priorLeafId, priorLeafId);
  const data = recoveryRecord(candidate, { recoveryId: "recovery-1", sessionId: "session-1", priorLeafId });
  const provenance = h.add({ type: "custom", customType: RECOVERY_STATE_TYPE, data });
  active = branchForLeaf(h.entries, provenance.id); plan = planRalphRecovery({ branch: active, entries: h.entries, sessionId: "session-1", leafId: provenance.id });
  assert.equal(plan.kind, "append-inactive");
  const recoveredState = h.add({ type: "custom", customType: "prime_ralph_execution_state", data: { ...inactiveExecutionState("session-1"), transition: 1, resetRequested: false, pendingRound: null, admittedContinuation: null, recoveryRequired: { protocolVersion: RECOVERY_PROTOCOL_VERSION, recoveryId: "recovery-1", requestId: candidate.requestId, rootRequestId: candidate.rootRequestId, anchorId: candidate.anchorId, priorLeafId } } });
  active = branchForLeaf(h.entries, recoveredState.id); plan = planRalphRecovery({ branch: active, entries: h.entries, sessionId: "session-1", leafId: recoveredState.id });
  assert.equal(plan.kind, "completed");
});

test("a later fresh execute poison remains recoverable after an earlier completed recovery", () => {
  const h = builder(); h.bundle({ requestId: "first-poison", command: "execute", workflowPhase: "execution", lifecycleId: "life-1", cycle: 1 });
  const firstPriorLeaf = h.leaf(), firstCandidate = findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1");
  h.setParent(firstCandidate.anchorId);
  const firstRecord = recoveryRecord(firstCandidate, { recoveryId: "recovery-1", sessionId: "session-1", priorLeafId: firstPriorLeaf });
  h.add({ type: "custom", customType: RECOVERY_STATE_TYPE, data: firstRecord });
  h.add({ type: "custom", customType: "prime_ralph_execution_state", data: { ...inactiveExecutionState("session-1"), transition: 1, resetRequested: false, pendingRound: null, admittedContinuation: null, recoveryRequired: { protocolVersion: RECOVERY_PROTOCOL_VERSION, recoveryId: "recovery-1", requestId: firstCandidate.requestId, rootRequestId: firstCandidate.rootRequestId, anchorId: firstCandidate.anchorId, priorLeafId: firstPriorLeaf } } });
  const secondAnchor = h.leaf();
  h.bundle({ requestId: "second-poison", command: "execute", workflowPhase: "execution", lifecycleId: "life-2", cycle: 1 });
  const plan = planRalphRecovery({ branch: h.branch(), entries: h.entries, sessionId: "session-1", leafId: h.leaf() });
  assert.equal(plan.kind, "navigate"); assert.equal(plan.candidate.requestId, "second-poison"); assert.equal(plan.candidate.anchorId, secondAnchor);
});

test("malformed, duplicate, mismatched, and unsafe evidence fails closed", async (t) => {
  for (const scenario of ["duplicate-message", "missing-compaction", "mismatched-command", "missing-correlation", "mismatched-marker", "unexpected-correlation", "unsafe-user-anchor"]) await t.test(scenario, () => {
    const h = builder();
    if (scenario === "unsafe-user-anchor") { h.anchor.type = "message"; h.anchor.message = { role: "user", content: "unsafe" }; }
    const poison = h.bundle({ requestId: "poison", command: "plan", workflowPhase: "planning" });
    if (scenario === "duplicate-message") h.add({ type: "custom_message", customType: RESET_MESSAGE_TYPE, content: poison.message.content, display: false, details: { ...poison.message.details } });
    if (scenario === "missing-compaction") h.entries.splice(h.entries.findIndex((entry) => entry.type === "compaction"), 1);
    if (scenario === "mismatched-command") poison.message.details.command = "reset";
    if (scenario === "missing-correlation") delete poison.terminalEntry.data.sessionId;
    if (scenario === "mismatched-marker") h.entries.find((entry) => entry.customType === RESET_STATE_TYPE && entry.data.status === "compacting").data.markerId = "other-marker";
    if (scenario === "unexpected-correlation") poison.marker.data.lifecycleId = "other-life";
    assert.throws(() => findPoisonedRecoveryCandidate(branchForLeaf(h.entries, h.leaf()), h.entries, "session-1"), RalphRecoveryError);
  });
});


test("a malformed current poison cannot be hidden by one valid candidate", () => {
  const h = builder(); h.bundle({ requestId: "valid", command: "plan", workflowPhase: "planning" });
  h.add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: "malformed", status: "failed", command: "plan" } });
  assert.throws(() => findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1"), RalphRecoveryError);
});

test("blocked recovery identities require durable provenance", () => {
  for (const profile of [
    { command: "blocked-pass", workflowPhase: "blocked", invocationMode: "blocked-start" },
    { command: "reset", workflowPhase: "planning", invocationMode: "blocked-restored" },
  ]) {
    const h = builder(); h.bundle({ requestId: "blocked-poison", provenanceId: "blocked-life", ...profile });
    for (const entry of h.entries) {
      const evidence = entry.type === "custom_message" ? entry.details : entry.type === "compaction" ? entry.details : entry.data;
      if (evidence?.requestId === "blocked-poison") delete evidence.provenanceId;
    }
    assert.throws(() => findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1"), /missing blocked provenance identity/);
  }
});

test("unknown anchors, invocation mismatches, and missing post-boundary execution state fail closed", async (t) => {
  await t.test("unknown anchor", () => {
    const h = builder(); h.anchor.type = "unknown_future_entry"; h.bundle({ requestId: "poison", command: "plan", workflowPhase: "planning" });
    assert.throws(() => findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1"), /unsafe edit semantics/);
  });
  await t.test("invocation mismatch", () => {
    const h = builder(); const poison = h.bundle({ requestId: "poison", command: "plan", workflowPhase: "planning" }); poison.message.details.invocationMode = "execution-start";
    assert.throws(() => findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1"), /missing or mismatched correlated reset evidence|mismatched invocation mode/);
  });
  await t.test("execution state only before hidden boundary", () => {
    const h = builder(); h.bundle({ requestId: "poison", command: "execute", workflowPhase: "execution", lifecycleId: "life", cycle: 1 });
    const execution = h.entries.find((entry) => entry.customType === "prime_ralph_execution_state"); const index = h.entries.indexOf(execution); h.entries[index + 1].parentId = execution.parentId; h.entries.splice(index, 1);
    assert.throws(() => findPoisonedRecoveryCandidate(branchForLeaf(h.entries, h.leaf()), h.entries, "session-1"), /no matching execution lifecycle state after/);
  });
});

test("user and custom-message anchors are never targetable", () => {
  for (const anchor of [{ type: "message", message: { role: "user", content: "x" } }, { type: "custom_message", customType: "x", content: "x", display: false }]) {
    const h = builder(); Object.assign(h.anchor, anchor); h.bundle({ requestId: "poison", command: "plan", workflowPhase: "planning" });
    assert.throws(() => findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1"), /unsafe edit semantics/);
  }
});


test("completed, unavailable, and multiple execution-root evidence is never recoverable", () => {
  const completed = builder(); completed.bundle({ requestId: "done", command: "plan", workflowPhase: "planning", terminal: "completed" });
  assert.throws(() => findPoisonedRecoveryCandidate(completed.branch(), completed.entries, "session-1"), /found 0/);

  const unavailable = builder(); const unavailableBundle = unavailable.bundle({ requestId: "short", command: "plan", workflowPhase: "planning" });
  unavailable.entries.splice(unavailable.entries.indexOf(unavailableBundle.message), 1);
  unavailableBundle.terminalEntry.data.status = "failed"; unavailableBundle.terminalEntry.data.reason = "compaction_unavailable";
  assert.throws(() => findPoisonedRecoveryCandidate(branchForLeaf(unavailable.entries, unavailable.leaf()), unavailable.entries, "session-1"), RalphRecoveryError);

  const roots = builder(); roots.bundle({ requestId: "root-1", command: "execute", workflowPhase: "execution", lifecycleId: "life", cycle: 1, terminal: "completed" });
  roots.bundle({ requestId: "root-2", command: "execute", workflowPhase: "execution", lifecycleId: "life", cycle: 1, terminal: "completed" });
  roots.bundle({ requestId: "poison", command: "execute-round", workflowPhase: "execution", lifecycleId: "life", cycle: 2 });
  assert.throws(() => findPoisonedRecoveryCandidate(roots.branch(), roots.entries, "session-1"), /initial execute boundary; found 2/);
});

test("null or missing marker parents fail closed", () => {
  for (const value of [null, "missing"]) {
    const h = builder(); const poison = h.bundle({ requestId: "poison", command: "plan", workflowPhase: "planning" }); poison.marker.parentId = value;
    assert.throws(() => findPoisonedRecoveryCandidate(h.branch(), h.entries, "session-1"), RalphRecoveryError);
  }
});
