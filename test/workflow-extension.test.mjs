import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowExtension } from "../src/workflow-extension.js";
import { PLANNING_MESSAGE_TYPE, PLANNING_STARTUP_MESSAGE_TYPE } from "../src/planning.js";
import { SPECIFICATION_MESSAGE_TYPE, STARTUP_PREPARE_MESSAGE_TYPE } from "../src/specification.js";
import { RESET_MARKER_TYPE, RESET_MESSAGE_TYPE, RESET_PROTOCOL_VERSION, RESET_STATE_TYPE, resetCompactionInstructions } from "../src/reset-context.js";
import { BLOCKED_MESSAGE_TYPE, EXECUTION_MESSAGE_TYPE, EXECUTION_STATE_ENTRY_TYPE, latestExecutionState } from "../src/execution.js";
import { RECOVERY_STATE_TYPE, branchForLeaf } from "../src/recovery.js";

const prepare = { path: "/project/.ralph/skills/prepare/SKILL.md", text: "---\nname: prepare\ndescription: test\n---\nprepare body" };
const specSkill = { path: "/project/.ralph/skills/spec-it-out/SKILL.md", text: "---\nname: spec-it-out\ndescription: test\nprime-ralph-invocation-version: 1\n---\nspec body" };
const planSkill = { path: "/project/.ralph/skills/plan/SKILL.md", text: "---\nname: plan\ndescription: test\nprime-ralph-invocation-version: 1\n---\nplan body" };
const executeSkill = { path: "/project/.ralph/skills/execute/SKILL.md", text: "---\nname: execute\ndescription: test\nprime-ralph-invocation-version: 1\n---\nexecute body" };
const blockedSkill = { path: "/project/.ralph/skills/blocked/SKILL.md", text: "---\nname: blocked\ndescription: test\nprime-ralph-invocation-version: 1\n---\nblocked body" };
function harness({ specificationState = "absent", planState = "absent", branch = [], inspectSpecError, inspectPlanError, sendError, loadPrepareError, loadPlanError, loadExecuteError, blockedState = "absent", blockedProofState = "complete", restoredProofState = "unproven", appendFailureAt: initialAppendFailureAt, appendFailureFrom: initialAppendFailureFrom, logFailureAt, sessionId = "session-1", rlmDepth = 0, sharedLogs, closeoutTimeoutMs, deliveryTimeoutMs, persistSent = true, signalAvailable = true, treeEntries: initialTreeEntries, navigateMode = "normal" } = {}) {
  const runAbortController = new AbortController();
  let runtimePersistSent = persistSent;
  const commands = new Map(), tools = new Map(), handlers = new Map(), sent = [], userMessages = [], notices = [], compactions = [], entries = [], logs = sharedLogs ?? [], transactions = [];
  const treeEntries = initialTreeEntries ?? [...branch];
  let leafId = branch.at(-1)?.id ?? null;
  const appendTreeEntry = (entry) => { branch.push(entry); treeEntries.push(entry); leafId = entry.id; };
  let liveSessionId = sessionId, liveSessionFile = `/sessions/${sessionId}.jsonl`;
  let spec = specificationState, plan = planState, blocked = blockedState, restored = restoredProofState, blockedLifecycle = [...branch].reverse().find((entry) => entry?.data?.provenanceId)?.data.provenanceId ?? "blocked-life", nextEntry = treeEntries.length, pending = false, idle = true, aborted = 0, idleWaits = 0, appendCalls = 0, appendFailureAt = initialAppendFailureAt, appendFailureFrom = initialAppendFailureFrom, logCalls = 0;
  let runtimeSignalAvailable = signalAvailable, signalSequence, signalReads = 0, pendingSequence, pendingReads = 0;
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { const values = handlers.get(name) ?? []; values.push(handler); handlers.set(name, values); },
    appendEntry(customType, data) { appendCalls += 1; if (appendCalls === appendFailureAt || (appendFailureFrom && appendCalls >= appendFailureFrom)) throw new Error("injected state append failure"); const entry = { type: "custom", id: `e${++nextEntry}`, parentId: leafId, timestamp: new Date().toISOString(), customType, data }; entries.push(entry); appendTreeEntry(entry); },
    sendUserMessage(message, options) { userMessages.push({ message, options }); },
    sendMessage(message, options) {
      if (sendError) throw sendError;
      sent.push({ message, options });
      if (runtimePersistSent) appendTreeEntry({ type: "custom_message", id: `e${++nextEntry}`, parentId: leafId, timestamp: new Date().toISOString(), ...message });
    },
  };
  createWorkflowExtension({
    loadPrepare: () => { if (loadPrepareError) throw loadPrepareError; return prepare; },
    loadSpecItOut: () => specSkill,
    loadPlan: () => { if (loadPlanError) throw loadPlanError; return planSkill; },
    loadExecute: () => { if (loadExecuteError) throw loadExecuteError; return executeSkill; },
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
    ...(deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs }),
  })(pi);
  const ctx = {
    cwd: "/project", waitForIdle: async () => { idleWaits += 1; }, isIdle: () => idle,
    hasPendingMessages: () => { const value = pendingSequence ? pendingSequence[Math.min(pendingReads, pendingSequence.length - 1)] : pending; pendingReads += 1; return value; },
    get signal() { const value = signalSequence ? signalSequence[Math.min(signalReads, signalSequence.length - 1)] : runtimeSignalAvailable ? runAbortController.signal : undefined; signalReads += 1; return value; },
    abort: () => { aborted += 1; },
    compact: (options) => compactions.push(options),
    sessionManager: { getBranch: () => branch, getEntries: () => treeEntries, getEntry: (id) => treeEntries.find((entry) => entry.id === id), getLeafId: () => leafId, getHeader: () => ({ id: liveSessionId, rlmDepth }), getSessionFile: () => liveSessionFile, getSessionId: () => liveSessionId },
    ui: { notify: (...args) => notices.push(args) },
  };
  const emitResults = async (name, event) => { const results = []; for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx)); return results; };
  const emit = async (name, event) => { await emitResults(name, event); };
  ctx.navigateTree = async (targetId, options) => {
    if (navigateMode === "changed-before") leafId = targetId;
    if (["cancel-session", "throw-session"].includes(navigateMode)) { liveSessionId = "changed-session"; liveSessionFile = "/sessions/changed-session.jsonl"; }
    const treeAbort = new AbortController(); if (navigateMode === "aborted-signal") treeAbort.abort();
    const results = await emitResults("session_before_tree", { preparation: { targetId, oldLeafId: leafId, userWantsSummary: options?.summarize ?? false, entriesToSummarize: [], commonAncestorId: navigateMode === "wrong-common" ? null : targetId }, signal: treeAbort.signal });
    if (["cancel", "cancel-session"].includes(navigateMode) || results.some((result) => result?.cancel === true)) return { cancelled: true };
    if (["throw", "throw-session"].includes(navigateMode)) throw new Error("injected navigation failure");
    const oldLeafId = leafId, targetBranch = branchForLeaf(treeEntries, targetId);
    branch.splice(0, branch.length, ...targetBranch); leafId = navigateMode === "wrong-leaf" ? oldLeafId : targetId;
    if (navigateMode === "wrong-leaf") branch.splice(0, branch.length, ...branchForLeaf(treeEntries, oldLeafId));
    await emit("session_tree", { newLeafId: leafId, oldLeafId, fromExtension: false });
    return { cancelled: false };
  };
  const settle = async () => {
    const message = sent.at(-1)?.message;
    await emit("message_start", { message: { role: "custom", ...message } });
    await emit("context", { messages: [{ role: "custom", ...message }] });
    await emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "settled" }], stopReason: "stop" } });
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  };
  return { commands, tools, handlers, sent, userMessages, notices, branch, entries, compactions, logs, transactions, ctx, emit, settle, state: () => latestExecutionState(branch, sessionId), treeEntries, navigationLeaf: () => leafId, idleWaits: () => idleWaits, addGoal: (data) => appendTreeEntry({ type: "custom", id: `e${++nextEntry}`, parentId: leafId, timestamp: new Date().toISOString(), customType: "thread_goal_state", data }), setPending: (value) => { pending = value; pendingSequence = undefined; pendingReads = 0; }, setPendingSequence: (values) => { pendingSequence = [...values]; pendingReads = 0; }, pendingReads: () => pendingReads,
    setSignalAvailable: (value) => { runtimeSignalAvailable = value; signalSequence = undefined; signalReads = 0; }, setSignalSequence: (values) => { signalSequence = [...values]; signalReads = 0; }, signalReads: () => signalReads,
    abortRun: () => runAbortController.abort(), setIdle: (value) => { idle = value; }, setPersistSent: (value) => { runtimePersistSent = value; }, aborted: () => aborted, setSpecification: (value) => { spec = value; }, setPlan: (value) => { plan = value; }, setRestored: (value) => { restored = value; }, setBlocked: (value) => { blocked = value; }, failStateAppendIn: (offset) => { appendFailureAt = appendCalls + offset; }, failAllStateAppends: () => { appendFailureFrom = appendCalls + 1; }, restoreStateAppends: () => { appendFailureAt = undefined; appendFailureFrom = undefined; }, logAttempts: () => logCalls };
}

function poisonedRecoveryFixture({ sessionId = "session-1", phase = "planning", command = "plan" } = {}) {
  const entries = []; let parentId = null, n = 0;
  const add = (entry) => { const value = { id: `r${++n}`, parentId, timestamp: `2026-09-06T00:00:${String(n).padStart(2, "0")}.000Z`, ...entry }; entries.push(value); parentId = value.id; return value; };
  const anchor = add({ type: "custom", customType: "recovery_anchor", data: {} });
  const requestId = "poison-request", lifecycleId = phase === "execution" ? "poison-life" : null, cycle = phase === "execution" ? 1 : null;
  const invocationMode = phase === "execution" ? "execution-start" : command === "plan" ? "planning-new" : `${phase}-reset`;
  const identity = { workflowPhase: phase, invocationMode, sessionId, ...(phase === "execution" ? { lifecycleId, cycle } : {}) };
  const marker = add({ type: "custom", customType: RESET_MARKER_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command, ...identity } });
  add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: "compacting", markerId: marker.id, command, ...identity } });
  add({ type: "compaction", summary: "", firstKeptEntryId: marker.id, tokensBefore: 99, customInstructions: resetCompactionInstructions(requestId), details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command, ...identity } });
  add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: "prepare_pending", mode: "compaction", command, ...identity } });
  add({ type: "custom_message", customType: RESET_MESSAGE_TYPE, content: "<skill>poison</skill>", display: false, details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command, ...identity } });
  if (phase === "execution") add({ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { source: "prime-ralph", protocolVersion: 1, sessionId, transition: 1, phase: "execution", status: "running", lifecycleId, cycle, driverGoalId: "driver", pendingDecision: null, wait: null, provenanceId: null, forwardConfirmed: false } });
  add({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "goal-complete", name: "goal", arguments: { action: "complete" } }] } });
  add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: "failed", reason: "missing_normal_turn_end", boundaryExists: true, command, ...identity } });
  if (phase === "execution") add({ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { source: "prime-ralph", protocolVersion: 1, sessionId, transition: 2, phase: "execution", status: "paused", lifecycleId, cycle, driverGoalId: "driver", pendingDecision: null, wait: null, provenanceId: null, forwardConfirmed: false, pauseReason: "execution agent ended without normal closeout" } });
  return { entries, branch: [...entries], anchor, priorLeafId: entries.at(-1).id, requestId };
}

function compactedPoisonedRecoveryFixture({ sessionId = "session-1" } = {}) {
  const entries = []; let parentId = null, n = 0, transition = 0;
  const add = (entry) => { const value = { id: `p${++n}`, parentId, timestamp: `2026-09-08T00:00:${String(n).padStart(2, "0")}.000Z`, ...entry }; entries.push(value); parentId = value.id; return value; };
  const anchor = add({ type: "custom", customType: "recovery_anchor", data: {} });
  const addBundle = ({ requestId, command, cycle, terminal }) => {
    const identity = { workflowPhase: "execution", invocationMode: command === "execute" ? "execution-start" : "execution-continue", sessionId, lifecycleId: "stale-life", cycle };
    const marker = add({ type: "custom", customType: RESET_MARKER_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command, ...identity } });
    add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: "compacting", markerId: marker.id, command, ...identity } });
    add({ type: "compaction", summary: "", firstKeptEntryId: marker.id, tokensBefore: 99, customInstructions: resetCompactionInstructions(requestId), details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command, ...identity } });
    add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: "prepare_pending", mode: "compaction", command, ...identity } });
    add({ type: "custom_message", customType: RESET_MESSAGE_TYPE, content: `<skill>${requestId}</skill>`, display: false, details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command, ...identity } });
    add({ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { source: "prime-ralph", protocolVersion: 1, sessionId, transition: ++transition, phase: "execution", status: "running", lifecycleId: "stale-life", cycle, driverGoalId: "retired-driver", pendingDecision: null, wait: null, provenanceId: null, forwardConfirmed: false } });
    add({ type: "message", message: { role: "assistant", stopReason: terminal === "completed" ? "stop" : "error", content: [{ type: "text", text: terminal === "completed" ? "ready" : "provider failed" }] } });
    const terminalEntry = add({ type: "custom", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status: terminal, command, ...(terminal === "failed" ? { reason: "provider_error", boundaryExists: true } : {}), ...identity } });
    return { marker, terminalEntry };
  };
  const root = addBundle({ requestId: "execute-root", command: "execute", cycle: 1, terminal: "completed" });
  const poison = addBundle({ requestId: "poison-round", command: "execute-round", cycle: 2, terminal: "failed" });
  const summary = add({ type: "compaction", summary: "valuable compacted history", firstKeptEntryId: poison.terminalEntry.id, tokensBefore: 500, details: { readFiles: [], modifiedFiles: [] } });
  const conversation = add({ type: "message", message: { role: "user", content: [{ type: "text", text: "valuable later conversation" }] } });
  add({ type: "custom", customType: "thread_goal_state", data: { active: false, status: "idle", goalId: "retired-driver", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 } });
  add({ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: {
    source: "prime-ralph", protocolVersion: 1, sessionId, transition: ++transition, phase: "planning", status: "inactive",
    lifecycleId: "stale-life", cycle: 2, driverGoalId: "retired-driver", pendingDecision: null, pendingRound: null, wait: null,
    provenanceId: null, forwardConfirmed: false, resetRequested: true,
    admittedContinuation: { identity: "retired-driver:1", goalId: "retired-driver", continuationsUsed: 1, cycle: 2, mode: "execution-continue", automaticCompactionRequestId: "poison-round" },
    pauseReason: "session quit",
  } });
  const unrelatedGoal = add({ type: "custom", customType: "thread_goal_state", data: { active: true, status: "active", goalId: "unrelated-goal", objective: "preserve me", tokensUsed: 1, timeUsedSeconds: 1, continuationsUsed: 0 } });
  return { entries, branch: [...entries], anchor, root, poison, summary, conversation, unrelatedGoal, priorLeafId: entries.at(-1).id };
}

test("post-compaction recovery appends in place and preserves summaries, conversation, and unrelated goal", async () => {
  const fixture = compactedPoisonedRecoveryFixture(), prefix = structuredClone(fixture.entries);
  const h = harness({ specificationState: "existing", planState: "existing", branch: [...fixture.branch], treeEntries: [...fixture.entries] });
  const before = { sent: h.sent.length, compactions: h.compactions.length, goals: h.treeEntries.filter((entry) => entry.customType === "thread_goal_state").length };
  const entriesBeforeReload = h.treeEntries.length;
  await h.emit("session_start", { reason: "reload" });
  assert.equal(h.treeEntries.length, entriesBeforeReload); assert.match(h.notices.at(-1)[0], /Use \/ralph-recover/);
  await h.commands.get("ralph-recover").handler("", h.ctx);
  assert.deepEqual(h.treeEntries.slice(0, prefix.length), prefix);
  assert.ok(h.branch.some((entry) => entry.id === fixture.summary.id));
  assert.ok(h.branch.some((entry) => entry.id === fixture.conversation.id));
  assert.ok(h.branch.some((entry) => entry.id === fixture.unrelatedGoal.id));
  const provenance = h.branch.find((entry) => entry.customType === RECOVERY_STATE_TYPE);
  assert.equal(provenance.parentId, fixture.priorLeafId);
  assert.equal(provenance.data.recoveryMode, "in-place");
  assert.equal(provenance.data.requestId, "poison-round");
  const state = h.state();
  assert.equal(state.phase, "planning"); assert.equal(state.status, "inactive"); assert.equal(state.lifecycleId, null); assert.equal(state.cycle, 0);
  assert.equal(state.driverGoalId, null); assert.equal(state.resetRequested, false); assert.equal(state.pauseReason, null);
  assert.equal(state.pendingDecision, null); assert.equal(state.pendingRound, null); assert.equal(state.wait, null);
  assert.equal(state.cancellation, null); assert.equal(state.block, null); assert.equal(state.completion, null); assert.equal(state.resumed, false);
  assert.deepEqual({ sent: h.sent.length, compactions: h.compactions.length, goals: h.treeEntries.filter((entry) => entry.customType === "thread_goal_state").length }, before);
  assert.deepEqual([...h.branch].reverse().find((entry) => entry.customType === "thread_goal_state").data, fixture.unrelatedGoal.data);
  const after = h.treeEntries.length;
  await h.commands.get("ralph-recover").handler("", h.ctx);
  assert.equal(h.treeEntries.length, after); assert.match(h.notices.at(-1)[0], /already complete/);
  const reloaded = harness({ specificationState: "existing", planState: "existing", branch: [...h.branch], treeEntries: [...h.treeEntries] });
  await reloaded.commands.get("ralph-recover").handler("", reloaded.ctx);
  assert.equal(reloaded.treeEntries.length, after); assert.match(reloaded.notices.at(-1)[0], /already complete/);
});

test("post-compaction append failures quarantine and reload resumes in place exactly", async (t) => {
  for (const offset of [1, 2]) await t.test(`append ${offset}`, async () => {
    const fixture = compactedPoisonedRecoveryFixture(), prefix = structuredClone(fixture.entries);
    const first = harness({ specificationState: "existing", planState: "existing", branch: [...fixture.branch], treeEntries: [...fixture.entries] });
    first.failStateAppendIn(offset);
    await first.commands.get("ralph-recover").handler("", first.ctx);
    assert.deepEqual(first.treeEntries.slice(0, prefix.length), prefix);
    assert.equal(first.sent.length, 0); assert.equal(first.compactions.length, 0);
    const afterFailure = first.treeEntries.length;
    await first.commands.get("ralph-recover").handler("", first.ctx);
    assert.equal(first.treeEntries.length, afterFailure); assert.match(first.notices.at(-1)[0], /quarantined/);
    const reloaded = harness({ specificationState: "existing", planState: "existing", branch: [...first.branch], treeEntries: [...first.treeEntries] });
    await reloaded.commands.get("ralph-recover").handler("", reloaded.ctx);
    assert.equal(reloaded.state().recoveryRequired?.recoveryMode, "in-place");
    assert.equal(reloaded.state().lifecycleId, null); assert.equal(reloaded.state().driverGoalId, null);
    assert.ok(reloaded.branch.some((entry) => entry.id === fixture.summary.id));
    assert.ok(reloaded.branch.some((entry) => entry.id === fixture.conversation.id));
    assert.equal(reloaded.sent.length, 0); assert.equal(reloaded.compactions.length, 0);
  });
});

test("registers the complete Slice 5 command and lifecycle-control surface", () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["reset", "spec-it-out", "plan", "ralph-recover", "execute"]);
  assert.deepEqual([...h.tools.keys()], ["ralph_lifecycle"]);
});

test("provider-free recovery navigates exactly, preserves the abandoned branch, and requires explicit later execute", async () => {
  const fixture = poisonedRecoveryFixture({ phase: "execution", command: "execute" });
  const prefix = structuredClone(fixture.entries);
  const h = harness({ specificationState: "existing", planState: "existing", branch: [...fixture.branch], treeEntries: [...fixture.entries] });
  const poisonedMessage = fixture.entries.find((entry) => entry.type === "custom_message");
  const abortsBefore = h.aborted();
  await h.emit("context", { messages: [{ role: "custom", ...poisonedMessage }, { role: "user", content: "ordinary probe" }] });
  assert.ok(h.aborted() > abortsBefore);
  const before = { sent: h.sent.length, compactions: h.compactions.length, goals: h.treeEntries.filter((entry) => entry.customType === "thread_goal_state").length, priorLeaf: h.navigationLeaf() };
  await h.commands.get("ralph-recover").handler("", h.ctx);
  assert.equal(h.idleWaits(), 0);
  assert.equal(h.navigationLeaf(), h.branch.at(-1).id);
  assert.equal(h.branch[0].id, fixture.anchor.id);
  assert.equal(h.branch.some((entry) => entry.id === fixture.priorLeafId), false);
  assert.ok(h.treeEntries.some((entry) => entry.id === fixture.priorLeafId));
  assert.deepEqual(h.treeEntries.slice(0, prefix.length), prefix);
  const provenance = h.branch.find((entry) => entry.customType === RECOVERY_STATE_TYPE);
  assert.equal(provenance.data.status, "navigation-verified");
  const state = h.state();
  assert.equal(state.phase, "planning"); assert.equal(state.status, "inactive"); assert.equal(state.lifecycleId, null); assert.equal(state.driverGoalId, null);
  assert.equal(state.recoveryRequired.recoveryId, provenance.data.recoveryId);
  assert.deepEqual({ sent: h.sent.length, compactions: h.compactions.length, goals: h.treeEntries.filter((entry) => entry.customType === "thread_goal_state").length, priorLeaf: before.priorLeaf }, before);
  assert.match(h.notices.at(-1)[0], /Inspect the worktree, active planning documents, and issue state/);
  const entriesAfter = h.treeEntries.length;
  await h.commands.get("ralph-recover").handler("", h.ctx);
  assert.equal(h.treeEntries.length, entriesAfter); assert.match(h.notices.at(-1)[0], /already complete/);
  await h.emit("session_start", { reason: "reload" });
  assert.equal(h.sent.length, 0);
  const aborts = h.aborted();
  await h.emit("context", { messages: [{ role: "user", content: "inspect status" }] });
  assert.equal(h.aborted(), aborts);
  await h.commands.get("execute").handler("", h.ctx);
  assert.equal(h.compactions.length, 1); assert.ok(h.state().recoveryRequired);
  await completeLatestResetCompaction(h);
  assert.equal(h.state().status, "running"); assert.equal(h.state().recoveryRequired, null);
  const noticesAfterFreshExecute = h.notices.length;
  await h.emit("session_start", { reason: "reload" });
  assert.equal(h.notices.slice(noticesAfterFreshExecute).some(([message]) => /Recovery remains required|recovery boundary/i.test(message)), false);
});

test("legacy v2 poisoned execution suppresses ordinary provider admission before recovery", async () => {
  const fixture = poisonedRecoveryFixture({ phase: "execution", command: "execute" });
  for (const entry of fixture.entries) {
    const evidence = entry.type === "custom_message" ? entry.details : entry.type === "compaction" ? entry.details : entry.data;
    if (evidence?.requestId !== fixture.requestId) continue;
    evidence.protocolVersion = 2;
    if (entry.type !== "custom_message") for (const field of ["workflowPhase", "invocationMode", "sessionId", "lifecycleId", "cycle", "provenanceId"]) delete evidence[field];
    if (entry.type === "compaction") entry.customInstructions = `prime-ralph-reset:v2:${fixture.requestId}`;
  }
  const h = harness({ branch: [...fixture.branch], treeEntries: [...fixture.entries] }), before = h.aborted();
  await h.emit("before_agent_start", {});
  await h.emit("context", { messages: [{ role: "user", content: "must not reach provider" }] });
  assert.ok(h.aborted() > before); assert.equal(h.sent.length, 0); assert.equal(h.compactions.length, 0);
  assert.match(h.notices.at(-1)[0], /No provider request was admitted/);
  const malformedEntries = structuredClone(fixture.entries), malformedBranch = structuredClone(fixture.branch);
  for (const collection of [malformedEntries, malformedBranch]) collection.find((entry) => entry.customType === RESET_STATE_TYPE && entry.data?.status === "compacting").data.markerId = "wrong-marker";
  const malformed = harness({ branch: malformedBranch, treeEntries: malformedEntries }), malformedBefore = malformed.aborted();
  await malformed.emit("context", { messages: [{ role: "user", content: "malformed legacy must remain denied" }] });
  assert.ok(malformed.aborted() > malformedBefore); assert.equal(malformed.sent.length, 0);
});

test("navigation cancellation, failure, wrong leaf, and concurrent leaf all fail before recovery append", async (t) => {
  for (const mode of ["cancel", "cancel-session", "throw", "throw-session", "wrong-leaf", "changed-before", "aborted-signal", "wrong-common"]) await t.test(mode, async () => {
    const fixture = poisonedRecoveryFixture();
    const h = harness({ specificationState: "existing", planState: "existing", branch: [...fixture.branch], treeEntries: [...fixture.entries], navigateMode: mode });
    const beforeEntries = h.treeEntries.length, beforeSent = h.sent.length, beforeCompactions = h.compactions.length;
    await h.commands.get("ralph-recover").handler("", h.ctx);
    assert.equal(h.treeEntries.filter((entry) => entry.customType === RECOVERY_STATE_TYPE).length, 0);
    assert.equal(h.treeEntries.length, beforeEntries); assert.equal(h.sent.length, beforeSent); assert.equal(h.compactions.length, beforeCompactions);
    assert.match(h.notices.at(-1)[0], /no provider request|No provider request/);
  });
});

test("each post-navigation append failure quarantines the runtime and reload resumes exactly", async (t) => {
  for (const offset of [1, 2]) await t.test(`append ${offset}`, async () => {
    const fixture = poisonedRecoveryFixture();
    const first = harness({ specificationState: "existing", planState: "existing", branch: [...fixture.branch], treeEntries: [...fixture.entries] });
    first.failStateAppendIn(offset);
    await first.commands.get("ralph-recover").handler("", first.ctx);
    assert.equal(first.sent.length, 0); assert.equal(first.compactions.length, 0);
    const afterFailure = first.treeEntries.length, abortsBeforeProbe = first.aborted();
    await first.emit("before_agent_start", {});
    await first.emit("context", { messages: [{ role: "user", content: "must not reach provider" }] });
    assert.ok(first.aborted() > abortsBeforeProbe); assert.equal(first.sent.length, 0); assert.equal(first.compactions.length, 0);
    await first.commands.get("ralph-recover").handler("", first.ctx);
    assert.equal(first.treeEntries.length, afterFailure); assert.match(first.notices.at(-1)[0], /quarantined/);
    const reloaded = harness({ specificationState: "existing", planState: "existing", branch: [...first.branch], treeEntries: [...first.treeEntries] });
    await reloaded.emit("session_start", { reason: "reload" });
    assert.equal(reloaded.sent.length, 0);
    const reloadAborts = reloaded.aborted();
    await reloaded.emit("context", { messages: [{ role: "user", content: "must remain provider-free" }] });
    assert.ok(reloaded.aborted() > reloadAborts);
    await reloaded.commands.get("ralph-recover").handler("", reloaded.ctx);
    assert.equal(reloaded.state().recoveryRequired?.protocolVersion, 1);
    assert.match(reloaded.notices.at(-1)[0], /recovered operator control/);
  });
});

test("recovery rejects arguments and malformed poison without tree or provider mutation", async () => {
  const fixture = poisonedRecoveryFixture(); fixture.branch.find((entry) => entry.type === "compaction").details.command = "wrong";
  const h = harness({ branch: [...fixture.branch], treeEntries: [...fixture.entries] });
  await assert.rejects(h.commands.get("ralph-recover").handler("later", h.ctx), /Usage/);
  await h.commands.get("ralph-recover").handler("", h.ctx);
  assert.equal(h.sent.length, 0); assert.equal(h.compactions.length, 0); assert.equal(h.treeEntries.filter((entry) => entry.customType === RECOVERY_STATE_TYPE).length, 0);
  assert.match(h.notices.at(-1)[0], /mismatched reset command evidence/);
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
  await completeLatestResetCompaction(h);
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
  await first.commands.get("reset").handler("", first.ctx); await completeLatestResetCompaction(first);
  assert.match(first.sent.at(-1).message.content, /"invocationMode":"specification-reset-existing"/);
  await first.settle();
  await first.commands.get("plan").handler("", first.ctx); await completeLatestResetCompaction(first); await first.settle();
  const rebuilt = harness({ branch, specificationState: "existing", planState: "absent", sessionId: "phase-session" });
  await rebuilt.emit("session_start", { reason: "reload" });
  await rebuilt.commands.get("reset").handler("", rebuilt.ctx); await completeLatestResetCompaction(rebuilt);
  assert.match(rebuilt.sent.at(-1).message.content, /"invocationMode":"planning-reset-new"/);
  assert.doesNotMatch(rebuilt.sent.at(-1).message.content, /<skill name="spec-it-out"/);
});

test("planning reset with an existing plan stays clean and never starts execution", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); await h.emit("session_start", { reason: "startup" });
  await h.commands.get("reset").handler("", h.ctx); await completeLatestResetCompaction(h);
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


test("complete proven blocked documents take startup precedence through native compaction", async () => {
  const blocked = harness({ specificationState: "existing", blockedState: "complete" });
  await blocked.emit("session_start", { reason: "startup" });
  assert.equal(blocked.sent.length, 0); assert.equal(blocked.compactions.length, 1);
  const boundary = await completeLatestResetCompaction(blocked);
  assert.equal(boundary.customType, RESET_MESSAGE_TYPE); assert.equal(boundary.details.command, "blocked-pass");
  assert.equal(blocked.sent[0].options.triggerTurn, false);
  assert.ok(boundary.content.indexOf('<skill name="prepare"') < boundary.content.indexOf('<skill name="blocked"'));
  assert.equal(blocked.state().blockedContextEstablished, true);
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
  await resumed.commands.get("reset").handler("", resumed.ctx); await completeLatestResetCompaction(resumed);
  assert.match(resumed.sent.at(-1).message.content, /"invocationMode":"specification-reset-existing"/);
  assert.doesNotMatch(resumed.sent.at(-1).message.content, /<skill name="plan"/);
});


async function completeLatestResetCompaction(h) {
  const options = h.compactions.at(-1);
  const requestId = options.customInstructions.split(":").at(-1);
  const marker = [...h.branch].reverse().find((entry) => entry?.type === "custom" && entry.customType === "prime_ralph_reset_marker" && entry.data?.requestId === requestId);
  assert.ok(marker?.id);
  h.branch.push({ type: "compaction", id: `compaction-${requestId}`, summary: "", firstKeptEntryId: marker.id, customInstructions: options.customInstructions, details: { command: marker.data.command } });
  options.onComplete({ summary: "", firstKeptEntryId: marker.id });
  const sent = h.sent.at(-1);
  const admitted = sent.message;
  if (sent.options?.triggerTurn !== false) {
    await h.emit("agent_start", {});
    await h.emit("message_start", { message: { role: "custom", ...admitted } });
    await h.emit("context", { messages: [{ role: "custom", ...admitted }] });
  }
  return admitted;
}

async function startExecution(h) {
  await h.commands.get("execute").handler("", h.ctx);
  assert.equal(h.compactions.length, 1);
  const admitted = await completeLatestResetCompaction(h);
  const state = h.state();
  assert.equal(state.status, "running");
  assert.equal(state.cycle, 1);
  assert.match(h.sent.at(-1).message.content, /"invocationMode":"execution-start"/);
  return state;
}
async function completeAutomaticRoundCompaction(h) {
  const pending = h.state().pendingRound;
  assert.equal(pending?.stage, "compacting");
  const marker = [...h.branch].reverse().find((entry) => entry?.type === "custom" && entry.customType === "prime_ralph_reset_marker" && entry.data?.requestId === pending.requestId);
  assert.ok(marker?.id);
  const options = h.compactions.at(-1), sentBefore = h.sent.length;
  options.onComplete({ summary: "", firstKeptEntryId: marker.id });
  assert.equal(h.state().pendingRound.stage, "admission-requested");
  assert.equal(h.sent.length, sentBefore + 1);
  const boundary = h.sent[sentBefore].message;
  assert.equal(boundary.customType, RESET_MESSAGE_TYPE);
  assert.equal(boundary.details.command, "execute-round");
  await h.emit("message_start", { message: { role: "custom", ...boundary } });
  const denied = await h.handlers.get("context")[0]({ messages: [{ role: "custom", ...boundary }] }, h.ctx);
  assert.deepEqual(denied, { messages: [] });
  await h.handlers.get("context").at(-1)({ messages: denied.messages }, h.ctx);
  await h.emit("agent_end", { messages: [{ role: "custom", ...boundary }, { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" }] });
  h.setSignalAvailable(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, sentBefore + 2);
  const release = h.sent[sentBefore + 1].message;
  h.setSignalAvailable(true); await h.emit("agent_start", {});
  await h.emit("message_start", { message: { role: "custom", ...release } });
  assert.equal(h.state().pendingRound?.stage, "admission-requested", JSON.stringify(h.state()));
  await h.emit("context", { messages: [{ role: "custom", ...boundary }, { role: "custom", ...release }] });
  assert.equal(h.state().pendingRound ?? null, null);
  return boundary;
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

test("session quit remains paused until explicit /execute resumes the same lifecycle", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-quit", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: initial.cycle });
  await h.emit("session_shutdown", { reason: "quit" });

  const paused = h.state();
  assert.equal(paused.status, "paused"); assert.equal(paused.pauseReason, "session quit");
  assert.equal(paused.lifecycleId, initial.lifecycleId); assert.equal(paused.cycle, initial.cycle);
  assert.equal(paused.driverGoalId, "goal-quit"); assert.equal(paused.pendingDecision, null);
  const transition = paused.transition, aborts = h.aborted(), notices = h.notices.length;

  await h.emit("before_agent_start", { prompt: "status update please" });
  await h.emit("turn_end", finalEvent("ordinary discussion remains outside the paused pass"));
  assert.equal(h.state().transition, transition); assert.equal(h.state().status, "paused");
  assert.equal(h.aborted(), aborts); assert.equal(h.notices.length, notices);

  await h.commands.get("execute").handler("", h.ctx);
  assert.equal(h.compactions.length, 2); assert.equal(h.state().status, "paused");
  assert.doesNotMatch(h.notices.at(-1)[0], /already running/);
  const boundary = await completeLatestResetCompaction(h);
  assert.equal(boundary.details.invocationMode, "execution-resume");
  assert.equal(h.state().status, "running"); assert.equal(h.state().lifecycleId, initial.lifecycleId);
  assert.equal(h.state().cycle, initial.cycle); assert.equal(h.state().driverGoalId, "goal-quit");
});

test("/execute never replaces a refused reset-flavor compaction with projection", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  await h.commands.get("execute").handler("", h.ctx);
  assert.equal(h.compactions.length, 1); assert.equal(h.state().status, "inactive");
  h.compactions[0].onError(new Error("Session is too short to compact — try again once it grows"));
  assert.equal(h.state().status, "inactive"); assert.equal(h.sent.length, 0);
  assert.equal(h.notices.at(-1)[0], "The Ralph execution pass was not started because native compaction was unavailable.");
});

test("continue compacts before it admits the next clean cycle", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content });
  await assert.rejects(control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 }), /native Prime Agent goal/);
  h.addGoal({ goalId: "goal-1", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  await h.emit("turn_end", finalEvent("completed first task"));
  assert.equal(h.logs.length, 0); assert.equal(h.state().cycle, 1); assert.equal(h.state().pendingDecision.action, "continue");
  const context = h.handlers.get("context").at(-1), goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-1", continuationsUsed: 1 } };
  await h.emit("message_start", { message: goalMessage });
  const held = await context({ messages: [{ role: "user", content: "stale" }, goalMessage] }, h.ctx);
  assert.deepEqual(held.messages, []); assert.equal(h.aborted(), 1);
  assert.equal(h.logs.length, 1); assert.equal(h.state().cycle, 1); assert.equal(h.state().pendingDecision, null);
  assert.equal(h.state().pendingRound.stage, "compacting"); assert.equal(h.compactions.length, 2);
  assert.equal(h.sent.filter(({ message }) => message.details?.command === "execute-round").length, 0);
  const armedIndex = h.branch.findIndex((entry) => entry?.customType === EXECUTION_STATE_ENTRY_TYPE && entry.data?.pendingRound?.stage === "armed");
  const markerIndex = h.branch.findIndex((entry) => entry?.customType === "prime_ralph_reset_marker" && entry.data?.requestId === h.state().pendingRound.requestId);
  const compactingIndex = h.branch.findIndex((entry) => entry?.customType === EXECUTION_STATE_ENTRY_TYPE && entry.data?.pendingRound?.stage === "compacting");
  assert.ok(armedIndex >= 0 && armedIndex < markerIndex && markerIndex < compactingIndex);

  const boundary = await completeAutomaticRoundCompaction(h);
  assert.equal(h.state().cycle, 2); assert.equal(h.state().admittedContinuation.identity, "goal-1:1");
  assert.match(boundary.content, /"cycle":2/); assert.match(boundary.content, /"invocationMode":"execution-continue"/);
  const providerMessages = [{ role: "compactionSummary", summary: "" }, { role: "user", content: "visible after compaction" }, boundary];
  const clean = await h.handlers.get("context")[0]({ messages: providerMessages }, h.ctx);
  assert.equal(clean, undefined);
  assert.deepEqual(providerMessages, [{ role: "compactionSummary", summary: "" }, { role: "user", content: "visible after compaction" }, boundary]);
  const transition = h.state().transition, sentCount = h.sent.length;
  h.compactions.at(-1).onComplete({ summary: "", firstKeptEntryId: h.branch[markerIndex].id });
  assert.equal(h.state().transition, transition); assert.equal(h.sent.length, sentCount);
});


test("workflow defers automatic replacement admission until the originating end", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-late-origin", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const cycleOne = finalEvent("cycle one complete");
  await h.emit("turn_end", cycleOne);
  await h.emit("agent_end", { messages: [cycleOne.message] });
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-late-origin", continuationsUsed: 1 } };
  await h.emit("agent_start", {});
  await h.emit("message_start", { message: goalMessage });
  await h.handlers.get("context").at(-1)({ messages: [goalMessage] }, h.ctx);
  const pending = h.state().pendingRound;
  const marker = [...h.branch].reverse().find((entry) => entry?.customType === RESET_MARKER_TYPE && entry.data?.requestId === pending.requestId);
  const sentBefore = h.sent.length;
  h.compactions.at(-1).onComplete({ summary: "", firstKeptEntryId: marker.id });
  assert.equal(h.sent.length, sentBefore + 1);
  const boundary = h.sent[sentBefore].message;
  await h.emit("message_start", { message: { role: "custom", ...boundary } });
  const denied = await h.handlers.get("context")[0]({ messages: [{ role: "custom", ...boundary }] }, h.ctx);
  assert.deepEqual(denied, { messages: [] });
  await h.handlers.get("context").at(-1)({ messages: denied.messages }, h.ctx);
  await h.emit("agent_end", { messages: [{ role: "custom", ...boundary }, { role: "assistant", stopReason: "aborted", content: [] }] });
  h.setSignalAvailable(false); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, sentBefore + 2);
  const release = h.sent[sentBefore + 1].message;
  h.setSignalAvailable(true); await h.emit("agent_start", {});
  await h.emit("message_start", { message: { role: "custom", ...release } });
  const admittedMessages = [{ role: "custom", ...boundary }, { role: "custom", ...release }];
  await h.emit("context", { messages: admittedMessages });
  assert.equal(h.state().cycle, 2); assert.equal(h.state().status, "running");

  const toolUse = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "replacement-tool", name: "goal", arguments: {} }] };
  const toolResult = { role: "toolResult", toolCallId: "replacement-tool", toolName: "goal", content: [], isError: false };
  await h.emit("tool_result", { type: "tool_result", toolCallId: toolResult.toolCallId, toolName: toolResult.toolName, input: {}, content: toolResult.content, isError: false });
  await h.emit("turn_end", { message: toolUse });
  h.setPending(true); h.setSignalAvailable(false);
  await h.emit("agent_end", { messages: [...admittedMessages, toolUse, toolResult] });
  assert.equal(h.state().cycle, 2); assert.equal(h.state().status, "running");
  assert.equal(h.branch.some((entry) => entry?.customType === RESET_STATE_TYPE && entry.data?.status === "failed" && entry.data?.requestId === pending.requestId), false);
});


test("workflow rejects an overtaking replacement abort before any tool witness or delayed origin end", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-overtaking-replacement", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const cycleOne = finalEvent("cycle one complete");
  await h.emit("turn_end", cycleOne);
  await h.emit("agent_end", { messages: [cycleOne.message] });
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-overtaking-replacement", continuationsUsed: 1 } };
  await h.emit("agent_start", {});
  await h.emit("message_start", { message: goalMessage });
  await h.handlers.get("context").at(-1)({ messages: [goalMessage] }, h.ctx);
  const pending = h.state().pendingRound;
  const marker = [...h.branch].reverse().find((entry) => entry?.customType === RESET_MARKER_TYPE && entry.data?.requestId === pending.requestId);
  const sentBefore = h.sent.length;
  h.compactions.at(-1).onComplete({ summary: "", firstKeptEntryId: marker.id });
  assert.equal(h.sent.length, sentBefore + 1);
  const boundary = h.sent[sentBefore].message;
  await h.emit("message_start", { message: { role: "custom", ...boundary } });
  const denied = await h.handlers.get("context")[0]({ messages: [{ role: "custom", ...boundary }] }, h.ctx);
  assert.deepEqual(denied, { messages: [] });
  await h.handlers.get("context").at(-1)({ messages: denied.messages }, h.ctx);
  await h.emit("agent_end", { messages: [{ role: "custom", ...boundary }, { role: "assistant", stopReason: "aborted", content: [] }] });
  h.setSignalAvailable(false); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, sentBefore + 2);
  const release = h.sent[sentBefore + 1].message;
  h.setSignalAvailable(true); await h.emit("agent_start", {});
  await h.emit("message_start", { message: { role: "custom", ...release } });
  const admittedMessages = [{ role: "custom", ...boundary }, { role: "custom", ...release }];
  await h.emit("context", { messages: admittedMessages });
  assert.equal(h.state().cycle, 2); assert.equal(h.state().status, "running");

  await h.emit("agent_end", { messages: [...admittedMessages, { role: "assistant", stopReason: "aborted", content: [] }] });

  const reset = [...h.branch].reverse().find((entry) => entry?.customType === RESET_STATE_TYPE && entry.data?.requestId === pending.requestId)?.data;
  assert.equal(reset.status, "failed"); assert.equal(reset.reason, "provider_aborted");
  assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /without normal closeout/);
});


test("workflow consumes an origin end before admission and rejects a later replacement abort", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-early-origin", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const cycleOne = finalEvent("cycle one complete");
  await h.emit("turn_end", cycleOne);
  await h.emit("agent_end", { messages: [cycleOne.message] });
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-early-origin", continuationsUsed: 1 } };
  await h.emit("agent_start", {});
  await h.emit("message_start", { message: goalMessage });
  await h.handlers.get("context").at(-1)({ messages: [goalMessage] }, h.ctx);
  const pending = h.state().pendingRound;
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "older history" }] }] });
  assert.equal(h.state().pendingRound.stage, "compacting"); assert.equal(h.state().status, "running");

  const marker = [...h.branch].reverse().find((entry) => entry?.customType === RESET_MARKER_TYPE && entry.data?.requestId === pending.requestId);
  h.compactions.at(-1).onComplete({ summary: "", firstKeptEntryId: marker.id });
  const boundary = h.sent.at(-1).message;
  await h.emit("agent_start", {});
  await h.emit("message_start", { message: { role: "custom", ...boundary } });
  await h.emit("context", { messages: [{ role: "custom", ...boundary }] });
  assert.equal(h.state().cycle, 2); assert.equal(h.state().status, "running");
  await h.emit("agent_end", { messages: [{ role: "custom", ...boundary }, { role: "assistant", stopReason: "aborted", content: [] }] });
  const reset = [...h.branch].reverse().find((entry) => entry?.customType === RESET_STATE_TYPE && entry.data?.requestId === pending.requestId)?.data;
  assert.equal(reset.status, "failed"); assert.equal(reset.reason, "provider_aborted");
  assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /without normal closeout/);
});


test("native goal pause and resume preserve the complete current iteration without projection", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-pause", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  await h.emit("turn_end", finalEvent("completed cycle one"));
  const originalGoal = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-pause", continuationsUsed: 1 } };
  const context = h.handlers.get("context").at(-1);
  assert.deepEqual((await context({ messages: [{ role: "user", content: "old cycle" }, originalGoal] }, h.ctx)).messages, []);
  const boundary = await completeAutomaticRoundCompaction(h);
  assert.equal(h.state().cycle, 2); assert.equal(h.state().admittedContinuation.identity, "goal-pause:1");

  const currentWork = { role: "assistant", content: "current iteration work" };
  const feedback = { role: "user", content: "keep this feedback" };
  const acknowledgement = { role: "assistant", content: "I will keep it" };
  h.addGoal({ goalId: "goal-pause", status: "paused", active: true });
  await h.emit("before_agent_start", { prompt: "paused-side-input" });
  assert.equal(h.state().status, "paused");
  h.addGoal({ goalId: "goal-pause", status: "active", active: true });
  const duplicateResume = { role: "custom", customType: "goal_context", content: "resume", details: { kind: "continuation", goalId: "goal-pause", continuationsUsed: 1 } };
  const messages = [boundary, currentWork, feedback, acknowledgement, duplicateResume];
  const beforeTransition = h.state().transition;
  const resumed = await context({ messages }, h.ctx);

  assert.equal(resumed, undefined);
  assert.deepEqual(messages, [boundary, currentWork, feedback, acknowledgement, duplicateResume]);
  assert.equal(h.state().status, "running"); assert.equal(h.state().cycle, 2); assert.equal(h.state().admittedContinuation.identity, "goal-pause:1");
  assert.equal(h.state().resumed, false); assert.equal(h.state().transition, beforeTransition + 1);
  assert.equal(h.compactions.length, 2); assert.equal(h.sent.filter(({ message }) => message.details?.command === "execute-round").length, 1);
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
  assert.deepEqual(projected.messages, []); assert.equal(h.aborted(), 1); assert.equal(h.logs.length, 1);
  assert.equal(h.state().status, "running"); assert.equal(h.state().cycle, 1); assert.equal(h.state().pendingRound.stage, "compacting");
  await completeAutomaticRoundCompaction(h);
  assert.equal(h.state().cycle, 2);

  await h.emit("turn_end", finalEvent("cycle two forgot its decision"));
  assert.equal(h.aborted(), 4); assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /without a lifecycle decision/);
});


test("a replacement continuation waits for the queued Ready turn_end closeout", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-before-ready", status: "complete", active: false });
  const waited = await control(h, { action: "wait", lifecycleId: initial.lifecycleId, cycle: 1, reason: "review", readiness: "review completes" });
  await h.emit("turn_end", finalEvent("waiting for review"));
  await h.emit("before_agent_start", { prompt: "review complete" });
  h.addGoal({ goalId: "goal-after-ready", status: "active", active: true });
  await control(h, { action: "ready", lifecycleId: initial.lifecycleId, cycle: 1, waitId: waited.details.waitId });

  const completed = finalEvent("readiness closeout"); completed.message.timestamp = 11;
  const goalMessage = { role: "custom", customType: "goal_context", content: "resume", details: { kind: "continuation", goalId: "goal-after-ready", continuationsUsed: 1 } };
  const context = h.handlers.get("context").at(-1);
  const projection = context({ messages: [completed.message, goalMessage] }, h.ctx);
  await Promise.resolve();
  assert.equal(h.aborted(), 0); assert.equal(h.state().pendingDecision.action, "ready"); assert.equal(h.state().pendingDecision.finalAssistantMessage, undefined);
  await h.emit("turn_end", structuredClone(completed));
  const projected = await projection;

  assert.equal(projected, undefined); assert.equal(h.aborted(), 0); assert.equal(h.logs.length, 0); assert.equal(h.compactions.length, 1);
  assert.equal(h.state().status, "running"); assert.equal(h.state().cycle, 1); assert.equal(h.state().pendingDecision, null);
  assert.equal(h.state().driverGoalId, "goal-after-ready"); assert.equal(h.state().admittedContinuation.identity, "goal-after-ready:1");
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
  assert.deepEqual(outcome.messages, []); assert.equal(h.aborted(), 1); assert.equal(h.logs.length, 1);
  assert.equal(h.state().cycle, 1); assert.equal(h.state().pendingRound.stage, "compacting");
  await completeAutomaticRoundCompaction(h);
  assert.equal(h.state().cycle, 2);
});


test("a same-pass before_agent_start owner consumes the native-pause retry candidate", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  await startExecution(h);
  h.addGoal({ goalId: "goal-native-pause-owner", status: "active", active: true });
  await h.emit("before_agent_start", { prompt: "bind exact driver" });
  h.addGoal({ goalId: "goal-native-pause-owner", status: "paused", active: true });
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" }] });
  assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /without normal closeout/);

  h.addGoal({ goalId: "goal-native-pause-owner", status: "active", active: true });
  await h.emit("before_agent_start", { prompt: "resume exact driver" });
  assert.equal(h.state().status, "running");
  const abortsBeforeStart = h.aborted();
  await h.emit("agent_start", {});
  assert.equal(h.aborted(), abortsBeforeStart); assert.equal(h.state().status, "running");

  await h.emit("turn_end", finalEvent("resumed pass remains owned"));
  assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /without a lifecycle decision/);
});

test("explicit /execute is not preempted by an in-memory abnormal-closeout retry witness", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-explicit-retry", status: "active", active: true });
  await h.emit("before_agent_start", { prompt: "bind exact driver" });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: initial.cycle });
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider failed" }] });
  assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /without normal closeout/);

  await h.commands.get("execute").handler("", h.ctx);
  assert.equal(h.compactions.length, 2); assert.equal(h.state().status, "paused");
  assert.doesNotMatch(h.notices.at(-1)[0], /already running/);
  const boundary = await completeLatestResetCompaction(h);
  assert.equal(boundary.details.invocationMode, "execution-resume");
  assert.equal(h.state().status, "running"); assert.equal(h.state().lifecycleId, initial.lifecycleId);
  assert.equal(h.state().cycle, initial.cycle); assert.equal(h.state().driverGoalId, "goal-explicit-retry");
});

test("retry ownership cannot survive reload or a changed active goal", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); await startExecution(h);
  h.addGoal({ goalId: "goal-retry-original", status: "active", active: true });
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "retryable" }] });
  const paused = h.state(); assert.equal(paused.status, "paused"); assert.equal(paused.driverGoalId, null);

  h.addGoal({ goalId: "goal-retry-changed", status: "active", active: true });
  const beforeChanged = h.state().transition;
  await h.emit("before_agent_start", { prompt: "changed driver must not inherit retry ownership" });
  assert.equal(h.state().status, "paused"); assert.equal(h.state().transition, beforeChanged);

  const reloaded = harness({ specificationState: "existing", planState: "existing", branch: [...h.branch] });
  const beforeReloaded = reloaded.state().transition;
  await reloaded.emit("before_agent_start", { prompt: "reloaded runtime has no retry witness" });
  await reloaded.emit("turn_end", finalEvent("ordinary reloaded discussion"));
  assert.equal(reloaded.state().status, "paused"); assert.equal(reloaded.state().transition, beforeReloaded);
});

test("a provider retry agent_start re-registers lifecycle closeout after error agent_end", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-provider-retry", status: "active", active: true });

  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1006" }] });
  assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /without normal closeout/);

  await h.emit("agent_start", {});
  assert.equal(h.state().status, "running", JSON.stringify(h.notices));
  const context = h.handlers.get("context").at(-1);
  const retried = await context({ messages: [{ role: "user", content: "original request" }] }, h.ctx);
  assert.equal(retried, undefined);

  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  const completed = finalEvent("completed after provider retry"); completed.message.timestamp = 12;
  await h.emit("turn_end", structuredClone(completed));
  assert.equal(h.state().pendingDecision.finalAssistantMessage, "completed after provider retry");

  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-provider-retry", continuationsUsed: 1 } };
  const projected = await context({ messages: [completed.message, goalMessage] }, h.ctx);
  assert.deepEqual(projected.messages, []); assert.equal(h.aborted(), 1); assert.equal(h.logs.length, 1);
  assert.equal(h.state().status, "running"); assert.equal(h.state().cycle, 1); assert.equal(h.state().pendingRound.stage, "compacting");
  await completeAutomaticRoundCompaction(h);
  assert.equal(h.state().cycle, 2); assert.equal(h.state().admittedContinuation.identity, "goal-provider-retry:1");
});


test("a direct retry with a changed native goal is aborted without lifecycle ownership", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  await startExecution(h);
  h.addGoal({ goalId: "goal-provider-original", status: "active", active: true });
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "retryable" }] });
  assert.equal(h.state().status, "paused");
  h.addGoal({ goalId: "goal-provider-changed", status: "active", active: true });

  await h.emit("agent_start", {});
  assert.equal(h.aborted(), 1); assert.equal(h.state().status, "paused");
  await h.emit("turn_end", finalEvent("must not gain retry ownership"));
  assert.equal(h.state().status, "paused");
  assert.match(h.notices.at(-1)[0], /goal driver changed or ended/);
});

test("a direct retry with a cleared or errored native goal is aborted fail closed", async (t) => {
  for (const status of ["idle", "error"]) await t.test(status, async () => {
    const h = harness({ specificationState: "existing", planState: "existing" });
    await startExecution(h);
    h.addGoal({ goalId: `goal-provider-${status}`, status: "active", active: true });
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "retryable" }] });
    h.addGoal({ goalId: status === "idle" ? null : `goal-provider-${status}`, status, active: false });

    await h.emit("agent_start", {});
    assert.equal(h.aborted(), 1); assert.equal(h.state().status, "paused");
    await h.emit("turn_end", finalEvent("must remain unowned"));
    assert.equal(h.state().status, "paused");
  });
});

test("a direct retry reconciliation append failure aborts and retains the durable pause", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  await startExecution(h);
  h.addGoal({ goalId: "goal-provider-append", status: "active", active: true });
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "retryable" }] });
  h.failStateAppendIn(1);

  await h.emit("agent_start", {});
  assert.equal(h.aborted(), 1); assert.equal(h.state().status, "paused");
  assert.match(h.state().pauseReason, /without normal closeout/);
  await h.emit("turn_end", finalEvent("must not gain ownership after append failure"));
  assert.equal(h.state().status, "paused");
  assert.match(h.notices.at(-1)[0], /before exact lifecycle ownership was restored/);
});

test("an agent-end pause append failure makes the next direct retry persist a closed state", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  await startExecution(h);
  h.addGoal({ goalId: "goal-provider-end-append", status: "active", active: true });
  h.failStateAppendIn(2);
  await assert.rejects(h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "retryable" }] }), /injected state append failure/);
  assert.equal(h.state().status, "running");
  h.restoreStateAppends();

  await h.emit("agent_start", {});
  assert.equal(h.aborted(), 1); assert.equal(h.state().status, "paused");
  assert.equal(h.state().pauseReason, "automatic retry lifecycle ownership could not be reclaimed");
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


test("agent end releases a pending Ready closeout waiter", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-ready-old", status: "complete", active: false });
  const waited = await control(h, { action: "wait", lifecycleId: initial.lifecycleId, cycle: 1, reason: "review", readiness: "done" });
  await h.emit("turn_end", finalEvent("waiting")); await h.emit("before_agent_start", { prompt: "ready" });
  h.addGoal({ goalId: "goal-ready-new", status: "active", active: true });
  await control(h, { action: "ready", lifecycleId: initial.lifecycleId, cycle: 1, waitId: waited.details.waitId });
  const completed = finalEvent("agent ends during Ready closeout"); completed.message.timestamp = 13;
  const goalMessage = { role: "custom", customType: "goal_context", content: "resume", details: { kind: "continuation", goalId: "goal-ready-new", continuationsUsed: 1 } };
  const projection = h.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, h.ctx);
  await Promise.resolve(); await h.emit("agent_end", { messages: [] });
  const outcome = await Promise.race([projection, new Promise((resolve) => setImmediate(() => resolve("still waiting")))]);
  assert.notEqual(outcome, "still waiting"); assert.deepEqual(outcome.messages, []);
  assert.equal(h.state().status, "paused"); assert.match(h.state().pauseReason, /ended without normal closeout/);
  assert.equal(h.state().cycle, 1); assert.equal(h.logs.length, 0); assert.equal(h.compactions.length, 1);
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
  await assert.rejects(h.handlers.get("agent_end").at(-1)({ messages: [] }, h.ctx), /injected state append failure/);
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
  assert.deepEqual(projected.messages, []); assert.equal(logs.length, 1); assert.equal(rebuilt.state().cycle, 1);
  assert.equal(rebuilt.state().status, "running"); assert.equal(rebuilt.state().pendingDecision, null); assert.equal(rebuilt.state().pendingRound.stage, "compacting");
  const boundary = await completeAutomaticRoundCompaction(rebuilt);
  assert.equal(rebuilt.state().cycle, 2); assert.match(boundary.content, /"cycle":2/);
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
  assert.deepEqual(projected.messages, []); assert.equal(h.aborted(), 2); assert.equal(h.logs.length, 0); assert.equal(h.state().cycle, 1); assert.equal(h.state().status, "paused");
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
  assert.equal(projected, undefined); assert.equal(h.state().admittedContinuation.identity, "goal-2:1");
});

test("a newer custom turn input prevents historical goal continuation misclassification after ready", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await startExecution(h);
  const historicalGoal = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-before-wait", continuationsUsed: 2 } };
  h.addGoal({ goalId: "goal-before-wait", status: "complete", active: false });
  const waited = await control(h, { action: "wait", lifecycleId: initial.lifecycleId, cycle: 1, reason: "review", readiness: "review finishes" });
  await h.emit("turn_end", finalEvent("waiting for review"));
  await h.emit("before_agent_start", { prompt: "review child handoff" });
  h.addGoal({ goalId: "replacement-goal", status: "active", active: true });
  await control(h, { action: "ready", lifecycleId: initial.lifecycleId, cycle: 1, waitId: waited.details.waitId });

  const childHandoff = { role: "custom", customType: "agent_message", content: "review complete", details: { id: "agentmsg_review", message: "review complete", fromRelationship: "child" } };
  const projected = await h.handlers.get("context").at(-1)({ messages: [{ role: "user", content: "earlier request" }, historicalGoal, childHandoff] }, h.ctx);
  assert.equal(projected, undefined);
  assert.equal(h.aborted(), 0);
  assert.equal(h.state().status, "running");
  assert.equal(h.state().driverGoalId, "replacement-goal");
  assert.equal(h.state().pendingDecision.action, "ready");
  await h.emit("turn_end", finalEvent("readiness accepted"));
  assert.equal(h.state().pendingDecision, null);
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
  assert.equal(projected, undefined);
  assert.equal(h.state().admittedContinuation.identity, "replacement-driver:1");
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
  await completeLatestResetCompaction(h);
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
  assert.equal(projected, undefined);
  assert.equal(rebuilt.state().admittedContinuation.identity, "replacement-driver:1");
  assert.equal(rebuilt.state().cycle, 1);
  assert.equal(rebuilt.logs.length, 0);
  const transition = rebuilt.state().transition;
  const repeated = await rebuilt.handlers.get("context").at(-1)({ messages: [completed.message, goalMessage] }, rebuilt.ctx);
  assert.equal(repeated, undefined);
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

test("queued goal-complete tool handoff preserves the admitted pass until wait closeout", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await startExecution(h);
  const boundary = h.sent.at(-1).message;
  h.addGoal({ goalId: "goal-handoff", status: "complete", active: false });
  const toolUse = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "goal-complete", name: "goal", arguments: { action: "complete" } }] };
  const toolResult = { role: "toolResult", toolCallId: "goal-complete", toolName: "goal", content: [{ type: "text", text: "Goal completed" }], isError: false };
  const before = { sent: h.sent.length, compactions: h.compactions.length, transition: h.state().transition, lifecycleId: h.state().lifecycleId, cycle: h.state().cycle, driverGoalId: h.state().driverGoalId, goals: h.branch.filter((entry) => entry?.customType === "thread_goal_state").length };
  await h.emit("tool_result", { type: "tool_result", toolCallId: toolResult.toolCallId, toolName: toolResult.toolName, input: {}, content: toolResult.content, isError: false });
  await h.emit("turn_end", { message: toolUse });
  h.setPendingSequence([true, false]);
  h.setSignalSequence([undefined, new AbortController().signal]);
  await h.emit("agent_end", { messages: [{ role: "custom", ...boundary }, toolUse, toolResult] });
  assert.equal(h.pendingReads(), 1); assert.equal(h.signalReads(), 1);
  assert.deepEqual({ sent: h.sent.length, compactions: h.compactions.length, transition: h.state().transition, lifecycleId: h.state().lifecycleId, cycle: h.state().cycle, driverGoalId: h.state().driverGoalId, goals: h.branch.filter((entry) => entry?.customType === "thread_goal_state").length }, before);
  assert.equal(h.state().status, "running");
  assert.equal(h.state().pendingDecision, null);
  const resetBefore = [...h.branch].reverse().find((entry) => entry?.customType === "prime_ralph_reset_state")?.data;
  assert.equal(resetBefore.status, "prepare_pending");

  h.setPending(false);
  const childMessage = { role: "custom", customType: "agent_message", content: "child result", details: { source: "agent_message" } };
  await h.emit("before_agent_start", { prompt: "[from child:auditor] result" });
  await h.emit("agent_start", {});
  await h.emit("message_start", { message: childMessage });
  const resumedMessages = [{ role: "custom", ...boundary }, toolUse, toolResult, childMessage];
  for (const context of h.handlers.get("context")) assert.equal(await context({ messages: resumedMessages }, h.ctx), undefined);
  assert.deepEqual(resumedMessages, [{ role: "custom", ...boundary }, toolUse, toolResult, childMessage]);
  assert.deepEqual({ sent: h.sent.length, compactions: h.compactions.length, transition: h.state().transition, lifecycleId: h.state().lifecycleId, cycle: h.state().cycle, driverGoalId: h.state().driverGoalId, goals: h.branch.filter((entry) => entry?.customType === "thread_goal_state").length }, before);
  const waited = await control(h, { action: "wait", lifecycleId: initial.lifecycleId, cycle: 1, reason: "review", readiness: "child result is durable" });
  assert.equal(waited.details.action, "wait");
  await h.emit("turn_end", finalEvent("Waiting for the durable child result."));
  await h.emit("agent_end", { messages: [finalEvent("Waiting for the durable child result.").message] });
  const resetAfter = [...h.branch].reverse().find((entry) => entry?.customType === "prime_ralph_reset_state")?.data;
  assert.equal(resetAfter.status, "completed");
  assert.equal(h.state().status, "waiting");
  assert.equal(h.state().cycle, 1);
  assert.equal(h.state().pendingDecision, null);
  assert.equal(h.aborted(), 0);
});

test("queued goal-complete tool handoff preserves block and complete closeout exactly once", async (t) => {
  for (const scenario of [
    { action: "block", params: { reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true }, expectedPhase: "blocked" },
    { action: "complete", params: { archive: false }, expectedPhase: "planning" },
  ]) {
    await t.test(scenario.action, async () => {
      const h = harness({ specificationState: "existing", planState: "existing" });
      const initial = await startExecution(h);
      const boundary = h.sent.at(-1).message;
      h.addGoal({ goalId: `goal-${scenario.action}`, status: "complete", active: false });
      const toolUse = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `goal-${scenario.action}`, name: "goal", arguments: { action: "complete" } }] };
      const toolResult = { role: "toolResult", toolCallId: `goal-${scenario.action}`, toolName: "goal", content: [{ type: "text", text: "Goal completed" }], isError: false };
      const before = { sent: h.sent.length, compactions: h.compactions.length, transition: h.state().transition, lifecycleId: h.state().lifecycleId, cycle: h.state().cycle, driverGoalId: h.state().driverGoalId };
      await h.emit("tool_result", { type: "tool_result", toolCallId: toolResult.toolCallId, toolName: toolResult.toolName, input: {}, content: toolResult.content, isError: false });
      await h.emit("turn_end", { message: toolUse });
      h.setPending(true);
      h.setSignalAvailable(false);
      await h.emit("agent_end", { messages: [{ role: "custom", ...boundary }, toolUse, toolResult] });
      assert.equal(h.state().status, "running");
      assert.deepEqual({ sent: h.sent.length, compactions: h.compactions.length, transition: h.state().transition, lifecycleId: h.state().lifecycleId, cycle: h.state().cycle, driverGoalId: h.state().driverGoalId }, before);
      h.setPending(false);
      const childMessage = { role: "custom", customType: "agent_message", content: `${scenario.action} child result` };
      await h.emit("before_agent_start", { prompt: childMessage.content });
      await h.emit("agent_start", {});
      await h.emit("message_start", { message: childMessage });
      const resumedMessages = [{ role: "custom", ...boundary }, toolUse, toolResult, childMessage];
      for (const context of h.handlers.get("context")) assert.equal(await context({ messages: resumedMessages }, h.ctx), undefined);
      assert.deepEqual({ sent: h.sent.length, compactions: h.compactions.length, transition: h.state().transition, lifecycleId: h.state().lifecycleId, cycle: h.state().cycle, driverGoalId: h.state().driverGoalId }, before);
      const result = await control(h, { action: scenario.action, lifecycleId: initial.lifecycleId, cycle: 1, ...scenario.params });
      assert.equal(result.details.action, scenario.action);
      const final = finalEvent(`${scenario.action} closeout`);
      await h.emit("turn_end", final);
      await h.emit("agent_end", { messages: [final.message] });
      const resetStates = h.branch.filter((entry) => entry?.customType === "prime_ralph_reset_state").map((entry) => entry.data);
      assert.equal(resetStates.filter((state) => state.status === "completed").length, 1);
      assert.equal(resetStates.some((state) => state.status === "failed"), false);
      assert.equal(h.state().phase, scenario.expectedPhase);
      assert.equal(h.state().pendingDecision, null);
      assert.equal(h.aborted(), 0);
      assert.equal(h.logs.length, 1);
    });
  }
});

test("queued handoff rejects a retained witness after current lifecycle identity changes", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await startExecution(h);
  const boundary = h.sent.at(-1).message;
  const toolUse = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "goal-complete", name: "goal", arguments: { action: "complete" } }] };
  const toolResult = { role: "toolResult", toolCallId: "goal-complete", toolName: "goal", content: [{ type: "text", text: "Goal completed" }], isError: false };
  await h.emit("tool_result", { type: "tool_result", toolCallId: toolResult.toolCallId, toolName: toolResult.toolName, input: {}, content: toolResult.content, isError: false });

  const currentIndex = h.branch.findLastIndex((entry) => entry?.type === "custom" && entry.customType === EXECUTION_STATE_ENTRY_TYPE);
  assert.equal(h.branch[currentIndex].data.lifecycleId, initial.lifecycleId);
  h.branch[currentIndex] = { ...h.branch[currentIndex], data: { ...h.branch[currentIndex].data, lifecycleId: "changed-lifecycle" } };
  h.setPending(true);
  h.setSignalAvailable(false);
  await h.emit("agent_end", { messages: [{ role: "custom", ...boundary }, toolUse, toolResult] });

  const reset = [...h.branch].reverse().find((entry) => entry?.customType === RESET_STATE_TYPE)?.data;
  assert.equal(reset.status, "failed");
  assert.equal(reset.reason, "missing_normal_turn_end");
  assert.equal(h.state().status, "paused");
  assert.equal(h.state().lifecycleId, initial.lifecycleId);
  assert.match(h.state().pauseReason, /without normal closeout/);
});

test("queued handoff rejects a durable provider abort omitted from the agent_end batch", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  await startExecution(h);
  const boundary = h.sent.at(-1).message;
  const toolUse = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "goal-complete", name: "goal", arguments: { action: "complete" } }] };
  const toolResult = { role: "toolResult", toolCallId: "goal-complete", toolName: "goal", content: [{ type: "text", text: "Goal completed" }], isError: false };
  await h.emit("tool_result", { type: "tool_result", toolCallId: toolResult.toolCallId, toolName: toolResult.toolName, input: {}, content: toolResult.content, isError: false });
  h.branch.push({ type: "message", id: "provider-abort", message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "provider aborted" }] } });
  h.setPending(true);
  h.setSignalAvailable(false);
  await h.emit("agent_end", { messages: [{ role: "custom", ...boundary }, toolUse, toolResult] });

  const reset = [...h.branch].reverse().find((entry) => entry?.customType === RESET_STATE_TYPE)?.data;
  assert.equal(reset.status, "failed");
  assert.equal(reset.reason, "missing_normal_turn_end");
  assert.equal(h.state().status, "paused");
  assert.match(h.state().pauseReason, /without normal closeout/);
});

test("planning reset cannot preserve a queued tool end without an active lifecycle turn", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  await h.commands.get("reset").handler("", h.ctx);
  await completeLatestResetCompaction(h);
  const boundary = h.sent.at(-1).message;
  await h.emit("message_start", { message: { role: "custom", ...boundary } });
  h.setPending(true);
  const toolUse = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "unowned", name: "ipython", arguments: {} }] };
  await h.emit("agent_end", { messages: [{ role: "custom", ...boundary }, toolUse] });
  const reset = [...h.branch].reverse().find((entry) => entry?.customType === "prime_ralph_reset_state")?.data;
  assert.equal(reset.status, "failed");
  assert.equal(reset.reason, "missing_normal_turn_end");
  assert.equal(h.state().status, "inactive");
});

test("queued handoff exemption rejects aborted, ambiguous, and non-current ends", async (t) => {
  const toolUse = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "goal-complete", name: "goal", arguments: { action: "complete" } }] };
  for (const scenario of [
    { name: "no pending host work", pending: false, messages: [toolUse] },
    { name: "run signal aborted after tool", pending: true, abortRun: true, messages: [toolUse] },
    { name: "missing live run signal", pending: true, signalAvailable: false, messages: [toolUse] },
    { name: "provider error", pending: true, messages: [{ role: "assistant", stopReason: "error", content: [] }], reason: "provider_error" },
    { name: "provider abort", pending: true, messages: [{ role: "assistant", stopReason: "aborted", content: [] }], reason: "provider_aborted" },
    { name: "older tool use followed by another assistant", pending: true, messages: [toolUse, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "older normal" }] }] },
  ]) {
    await t.test(scenario.name, async () => {
      const h = harness({ specificationState: "existing", planState: "existing", signalAvailable: scenario.signalAvailable ?? true });
      await startExecution(h);
      h.setPending(scenario.pending);
      if (scenario.abortRun) h.abortRun();
      await h.emit("agent_end", { messages: scenario.messages });
      const reset = [...h.branch].reverse().find((entry) => entry?.customType === "prime_ralph_reset_state")?.data;
      assert.equal(reset.status, "failed");
      assert.equal(reset.reason, scenario.reason ?? "missing_normal_turn_end");
      assert.equal(h.state().status, "paused");
      assert.match(h.state().pauseReason, /without normal closeout/);
    });
  }
});

test("execution agent_end without a new normal turn never authorizes the admitted hidden boundary", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  await h.commands.get("execute").handler("", h.ctx);
  const staleBoundary = await completeLatestResetCompaction(h);
  assert.equal(h.state().status, "running");
  await h.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "older planning response" }], stopReason: "stop" }] });
  const reset = [...h.branch].reverse().find((entry) => entry?.customType === "prime_ralph_reset_state")?.data;
  assert.equal(reset.status, "failed"); assert.equal(reset.reason, "missing_normal_turn_end");
  assert.equal(h.state().status, "paused");
  const before = h.aborted();
  await h.emit("context", { messages: [{ role: "custom", ...staleBoundary }, { role: "user", content: "ordinary follow-up" }] });
  assert.equal(h.aborted(), before + 1);
});

test("initial execution admission failure blocks the durable hidden prompt from later provider requests", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  h.failStateAppendIn(4);
  await h.commands.get("execute").handler("", h.ctx);
  const staleBoundary = await completeLatestResetCompaction(h);
  assert.notEqual(h.state().status, "running");
  const before = h.aborted();
  await h.emit("context", { messages: [{ role: "custom", ...staleBoundary }, { role: "user", content: "ordinary follow-up" }] });
  assert.equal(h.aborted(), before + 1);
  assert.match(h.notices.at(-1)[0], /prior Ralph context boundary was not admitted/);
});

test("execution reset requests a later boundary, waiting defers, and paused reset does not trigger a turn", async () => {
  const running = harness({ specificationState: "existing", planState: "existing" }); await startExecution(running); running.setIdle(false);
  await running.commands.get("reset").handler("", running.ctx); assert.equal(running.state().resetRequested, true); assert.equal(running.compactions.length, 1); assert.equal(running.userMessages[0].options.deliverAs, "steer"); assert.match(running.userMessages[0].message, /earliest eligible boundary/);
  const pausedBranch = [{ type: "custom", customType: EXECUTION_STATE_ENTRY_TYPE, data: { protocolVersion: 1, source: "prime-ralph", sessionId: "session-1", transition: 2, phase: "execution", status: "paused", lifecycleId: "life", cycle: 1, driverGoalId: "goal", pendingDecision: null, wait: null, provenanceId: null, forwardConfirmed: false } }];
  const paused = harness({ branch: pausedBranch, specificationState: "existing", planState: "existing" });
  await paused.commands.get("reset").handler("", paused.ctx); assert.equal(paused.compactions.length, 1); await completeLatestResetCompaction(paused);
  assert.equal(paused.sent.at(-1).options.triggerTurn, false); assert.match(paused.sent.at(-1).message.content, /execution-reset-paused/);
  await paused.commands.get("reset").handler("", paused.ctx); assert.equal(paused.compactions.length, 2);
});

test("execution to blocked starts no blocked pass before native compaction", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content }); h.addGoal({ goalId: "goal", status: "complete", active: false });
  await control(h, { action: "block", lifecycleId: initial.lifecycleId, cycle: 1, reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true });
  assert.equal(h.transactions[0].operation, "block"); assert.equal(h.state().phase, "blocked");
  await h.emit("turn_end", finalEvent("Please authenticate the provider.")); assert.equal(h.logs.length, 1);
  assert.equal(h.compactions.length, 1); assert.equal(h.sent.filter((item) => item.message.details?.command === "blocked-pass").length, 0);
  await h.emit("agent_end", { messages: [finalEvent("Please authenticate the provider.").message] });
  assert.equal(h.compactions.length, 2); assert.equal(h.state().blockedContextEstablished, false);
  const boundary = await completeLatestResetCompaction(h);
  assert.equal(boundary.details.command, "blocked-pass"); assert.equal(boundary.details.invocationMode, "blocked-start");
  assert.equal(h.sent.at(-1).options.triggerTurn, false); assert.equal(h.state().blockedContextEstablished, true);
  const before = h.handlers.get("before_agent_start").at(-1);
  assert.equal(await before({ prompt: "Credentials are restored" }, h.ctx), undefined);
  const context = h.handlers.get("context").at(-1);
  const user = { role: "user", content: "Credentials are restored" };
  const messages = [{ role: "compactionSummary", summary: "" }, { role: "custom", ...boundary }, user];
  assert.equal(await context({ messages }, h.ctx), undefined);
  assert.deepEqual(messages, [{ role: "compactionSummary", summary: "" }, { role: "custom", ...boundary }, user]);
});


test("blocked-pass compaction refusal admits no blocked provider request", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content }); h.addGoal({ goalId: "goal", status: "complete", active: false });
  await control(h, { action: "block", lifecycleId: initial.lifecycleId, cycle: 1, reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true });
  await h.emit("turn_end", finalEvent("Please authenticate the provider."));
  await h.emit("agent_end", { messages: [finalEvent("Please authenticate the provider.").message] });
  assert.equal(h.compactions.length, 2); h.compactions.at(-1).onError(new Error("Session is too short to compact"));
  assert.equal(h.state().phase, "blocked"); assert.equal(h.state().blockedContextEstablished, false);
  assert.equal(h.sent.filter((item) => item.message.details?.command === "blocked-pass").length, 0);
  const before = h.aborted(); assert.equal(await h.handlers.get("before_agent_start").at(-1)({ prompt: "Credentials are restored" }, h.ctx), undefined);
  assert.equal(h.aborted(), before + 1); assert.match(h.notices.at(-1)[0], /Use \/reset to retry/);
});

test("reload never replays an uncertain blocked-pass compaction", async () => {
  const branch = [], h = harness({ branch, specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content }); h.addGoal({ goalId: "goal", status: "complete", active: false });
  await control(h, { action: "block", lifecycleId: initial.lifecycleId, cycle: 1, reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true });
  await h.emit("turn_end", finalEvent("Please authenticate the provider."));
  await h.emit("agent_end", { messages: [finalEvent("Please authenticate the provider.").message] });
  assert.equal(h.compactions.length, 2);
  const rebuilt = harness({ branch, blockedState: "complete", specificationState: "absent", planState: "absent" });
  await rebuilt.emit("session_start", { reason: "reload" });
  assert.equal(rebuilt.compactions.length, 0); assert.equal(rebuilt.sent.length, 0); assert.equal(rebuilt.state().blockedContextEstablished, false);
  assert.match(rebuilt.notices.at(-1)[0], /compaction is incomplete/);
});

test("reload never promotes a blocked boundary whose state admission failed", async () => {
  const branch = [], h = harness({ branch, specificationState: "existing", planState: "existing" }); const initial = await startExecution(h);
  await h.emit("before_agent_start", { prompt: h.sent.at(-1).message.content }); h.addGoal({ goalId: "goal", status: "complete", active: false });
  await control(h, { action: "block", lifecycleId: initial.lifecycleId, cycle: 1, reason: "credential missing", unblockCondition: "operator authenticates", wakeupsStopped: true });
  await h.emit("turn_end", finalEvent("Please authenticate the provider."));
  await h.emit("agent_end", { messages: [finalEvent("Please authenticate the provider.").message] });
  h.failStateAppendIn(2);
  const staleBoundary = await completeLatestResetCompaction(h);
  assert.equal(h.state().blockedContextEstablished, false);
  assert.equal([...branch].reverse().find((entry) => entry?.customType === "prime_ralph_reset_state").data.status, "failed");

  const rebuilt = harness({ branch, blockedState: "complete", specificationState: "absent", planState: "absent" });
  await rebuilt.emit("session_start", { reason: "reload" });
  assert.equal(rebuilt.compactions.length, 0); assert.equal(rebuilt.sent.length, 0);
  assert.equal(rebuilt.state().blockedContextEstablished, false);
  assert.match(rebuilt.notices.at(-1)[0], /compaction is incomplete/);
  const before = rebuilt.aborted();
  await rebuilt.emit("context", { messages: [{ role: "custom", ...staleBoundary }, { role: "user", content: "Credentials are restored" }] });
  assert.equal(rebuilt.aborted(), before + 1);
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
  assert.equal(rebuilt.compactions.length, 1); assert.equal(rebuilt.sent.length, 0);
  const blockedBoundary = await completeLatestResetCompaction(rebuilt);
  assert.equal(blockedBoundary.details.command, "blocked-pass"); assert.equal(blockedBoundary.details.invocationMode, "blocked-start");
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
  await completeLatestResetCompaction(h);
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
  await h.commands.get("execute").handler("", h.ctx); await completeLatestResetCompaction(h); assert.equal(h.state().status, "running"); assert.notEqual(h.state().lifecycleId, "blocked-life");
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

test("blocked context is marked established only after native compaction and durable no-turn admission", async () => {
  const h = harness({ blockedState: "complete" }); await h.emit("session_start", { reason: "startup" });
  assert.equal(h.state().blockedContextEstablished, false); assert.equal(h.sent.length, 0); assert.equal(h.compactions.length, 1);
  await completeLatestResetCompaction(h);
  assert.equal(h.state().blockedContextEstablished, true); assert.equal(h.sent[0].options.triggerTurn, false);
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
  const h = harness({ blockedState: "complete", specificationState: "absent" }); await h.emit("session_start", { reason: "startup" }); await completeLatestResetCompaction(h);
  await h.commands.get("spec-it-out").handler("", h.ctx); const message = h.sent.at(-1).message;
  assert.equal(message.customType, SPECIFICATION_MESSAGE_TYPE); assert.equal(message.details.mode, "specification-existing"); assert.equal(message.details.specificationPath, ".ralph/plans/blocked/SPECIFICATION.md"); assert.match(message.content, /Do not offer future-specification creation/);
});

test("ordinary running execution does not use the generic execution projection fallback", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); await startExecution(h);
  const context = h.handlers.get("context").at(-1);
  const messages = [
    { role: "user", content: "keep old current-iteration input" },
    { role: "custom", customType: EXECUTION_MESSAGE_TYPE, content: "old execution message", details: { source: "prime-ralph", protocolVersion: 1, lifecycleId: h.state().lifecycleId } },
    { role: "assistant", content: "keep later current-iteration output" },
  ];
  const before = h.state();
  assert.equal(await context({ messages }, h.ctx), undefined);
  assert.deepEqual(h.state(), before);
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
  assert.equal(h.sent.length, 0); assert.equal(h.compactions.length, 1);
  const boundary = await completeLatestResetCompaction(h);
  assert.equal(boundary.customType, RESET_MESSAGE_TYPE); assert.equal(boundary.details.invocationMode, "blocked-restored");
  assert.match(boundary.content, /Do not move the files again/); assert.doesNotMatch(boundary.content, /forwardConfirmed/);
  assert.equal(await h.handlers.get("before_agent_start").at(-1)({ prompt: "BLOCKED_RECOVERY_USER_RESPONSE" }, h.ctx), undefined);
  assert.equal(h.state().blockedContextEstablished, true);
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
  await h.commands.get("reset").handler("", h.ctx); await completeLatestResetCompaction(h);
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
  const messages = [{ role: "user", content: "visible history" }, boundary, call, result];
  const projected = await h.handlers.get("context").at(-1)({ messages }, h.ctx);
  assert.equal(projected, undefined);
  assert.deepEqual(messages, [{ role: "user", content: "visible history" }, boundary, call, result]);
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
  await h.emit("session_start", { reason: "reload" }); assert.equal(h.sent.length, 0); assert.equal(h.compactions.length, 1);
  const boundary = await completeLatestResetCompaction(h); assert.equal(boundary.details.invocationMode, "blocked-restored");
  await h.emit("session_start", { reason: "reload" }); assert.equal(h.sent.length, 1); assert.equal(h.compactions.length, 1);
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


test("short, failed, and unexpected automatic compaction outcomes admit no next round", async () => {
  for (const outcome of ["short", "failed", "unexpected"]) {
    const h = harness({ specificationState: "existing", planState: "existing", sessionId: `compaction-${outcome}` }); const initial = await startExecution(h);
    h.addGoal({ goalId: `goal-${outcome}`, status: "active", active: true });
    await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
    await h.emit("turn_end", finalEvent(`finished ${outcome}`));
    const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: `goal-${outcome}`, continuationsUsed: 1 } };
    assert.deepEqual((await h.handlers.get("context").at(-1)({ messages: [goalMessage] }, h.ctx)).messages, []);
    const marker = [...h.branch].reverse().find((entry) => entry?.customType === "prime_ralph_reset_marker" && entry.data?.requestId === h.state().pendingRound.requestId);
    if (outcome === "short") h.compactions.at(-1).onError(new Error("Session is too short to compact — try again once it grows"));
    else if (outcome === "failed") h.compactions.at(-1).onError(new Error("provider failed"));
    else h.compactions.at(-1).onComplete({ summary: "wrong", firstKeptEntryId: marker.id });
    assert.equal(h.state().status, "paused", outcome); assert.equal(h.state().cycle, 1, outcome);
    assert.equal(h.state().pendingRound.stage, "failed", outcome); assert.equal(h.state().compactionHalted, true, outcome);
    assert.equal(h.sent.filter(({ message }) => message.details?.command === "execute-round").length, 0, outcome);
  }
});

test("dropped automatic boundary terminalizes provider-free and restores operator control without identity replay", async () => {
  const h = harness({ specificationState: "existing", planState: "existing", sessionId: "delivery-drop", deliveryTimeoutMs: 1 });
  const initial = await startExecution(h);
  const initialBoundary = h.sent.at(-1).message;
  await h.emit("message_start", { message: { role: "custom", ...initialBoundary } });
  await h.emit("context", { messages: [{ role: "custom", ...initialBoundary }] });
  h.addGoal({ goalId: "goal-delivery-drop", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  await h.emit("turn_end", finalEvent("finished before dropped boundary"));
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "finished before dropped boundary" }] }] });
  await h.handlers.get("context").at(-1)({ messages: [{ role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-delivery-drop", continuationsUsed: 1 } }] }, h.ctx);
  const pending = h.state().pendingRound;
  const marker = [...h.branch].reverse().find((entry) => entry?.customType === RESET_MARKER_TYPE && entry.data?.requestId === pending.requestId);
  h.setPersistSent(false);
  h.branch.push({ type: "compaction", id: `compaction-${pending.requestId}`, summary: "", firstKeptEntryId: marker.id, customInstructions: h.compactions.at(-1).customInstructions, details: { command: "execute-round" } });
  h.compactions.at(-1).onComplete({ summary: "", firstKeptEntryId: marker.id });
  h.setSignalAvailable(false);
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", content: [] }] });
  await new Promise((resolve) => setTimeout(resolve, 15));

  const failed = h.state();
  assert.equal(failed.status, "paused", JSON.stringify({ failed, resets: h.branch.filter((entry) => entry.customType === RESET_STATE_TYPE).map((entry) => entry.data), notices: h.notices }));
  assert.equal(failed.pendingRound.stage, "failed");
  assert.equal(failed.pendingRound.requestId, pending.requestId);
  assert.equal(failed.lifecycleId, initial.lifecycleId);
  assert.equal(failed.driverGoalId, "goal-delivery-drop");
  assert.equal(failed.cycle, 1);
  assert.equal(h.branch.some((entry) => entry.type === "custom_message" && entry.customType === RESET_MESSAGE_TYPE && entry.details?.requestId === pending.requestId), false);
  assert.equal([...h.branch].reverse().find((entry) => entry.customType === RESET_STATE_TYPE && entry.data?.requestId === pending.requestId)?.data.reason, "skill_boundary_delivery_missing");

  const abortsBeforeInput = h.aborted();
  const recoveryInput = [];
  for (const handler of h.handlers.get("input") ?? []) recoveryInput.push(await handler({ text: "are you there?", source: "interactive" }, h.ctx));
  assert.equal(recoveryInput.some((result) => result?.action === "handled"), true);
  assert.equal(h.aborted(), abortsBeforeInput);
  assert.match(h.notices.at(-1)[0], /goal clear/);

  h.addGoal({ goalId: "goal-delivery-drop", status: "idle", active: false });
  const restoredInput = [];
  for (const handler of h.handlers.get("input") ?? []) restoredInput.push(await handler({ text: "operator control restored", source: "interactive" }, h.ctx));
  assert.equal(restoredInput.some((result) => result?.action === "handled"), false);
  assert.equal(h.state().phase, "planning");
  assert.equal(h.state().status, "inactive");
  assert.equal(h.state().pendingRound, null);
  assert.equal(h.state().lifecycleId, initial.lifecycleId);
  assert.equal(h.state().cycle, 1);
});

test("automatic compaction reload fails a pending durable boundary and never replays uncertain work", async () => {
  const branch = [], logs = [];
  const first = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId: "automatic-reload" }); const initial = await startExecution(first);
  first.addGoal({ goalId: "goal-reload-automatic", status: "active", active: true });
  await control(first, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  await first.emit("turn_end", finalEvent("finished before reload"));
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-reload-automatic", continuationsUsed: 1 } };
  await first.handlers.get("context").at(-1)({ messages: [goalMessage] }, first.ctx);
  const pending = first.state().pendingRound, marker = [...branch].reverse().find((entry) => entry?.customType === "prime_ralph_reset_marker" && entry.data?.requestId === pending.requestId);
  first.compactions.at(-1).onComplete({ summary: "", firstKeptEntryId: marker.id });
  assert.equal(first.state().pendingRound.stage, "admission-requested");

  const rebuilt = harness({ branch, sharedLogs: logs, specificationState: "existing", planState: "existing", sessionId: "automatic-reload" });
  await rebuilt.emit("session_start", { reason: "reload" });
  assert.equal(rebuilt.state().cycle, 1); assert.equal(rebuilt.state().pendingRound.stage, "failed");
  assert.equal(rebuilt.state().status, "paused"); assert.equal(rebuilt.sent.length, 0);

  const uncertainBranch = branch.filter((entry) => !(entry?.type === "custom_message" && entry.details?.command === "execute-round"));
  // Remove the later admitted state too, leaving the durable admission-requested record without its message.
  while (uncertainBranch.at(-1)?.customType === EXECUTION_STATE_ENTRY_TYPE && uncertainBranch.at(-1).data?.pendingRound == null) uncertainBranch.pop();
  const uncertain = harness({ branch: uncertainBranch, specificationState: "existing", planState: "existing", sessionId: "automatic-reload" });
  await uncertain.emit("session_start", { reason: "reload" });
  assert.equal(uncertain.state().status, "paused"); assert.equal(uncertain.state().pendingRound.stage, "failed"); assert.equal(uncertain.sent.length, 0);

  const operator = harness({ branch: [...uncertainBranch], specificationState: "existing", planState: "existing", sessionId: "automatic-reload" });
  const firstInput = [];
  for (const handler of operator.handlers.get("input") ?? []) firstInput.push(await handler({ text: "are you there?", source: "interactive" }, operator.ctx));
  assert.equal(firstInput.some((result) => result?.action === "handled"), true);
  assert.equal(operator.aborted(), 0);
  assert.match(operator.notices.at(-1)[0], /goal clear/);
  assert.equal(operator.state().pendingRound.stage, "failed");
  assert.equal(operator.state().cycle, 1);

  operator.addGoal({ goalId: "goal-reload-automatic", status: "idle", active: false });
  const afterGoalClear = [];
  for (const handler of operator.handlers.get("input") ?? []) afterGoalClear.push(await handler({ text: "operator control restored", source: "interactive" }, operator.ctx));
  assert.equal(afterGoalClear.some((result) => result?.action === "handled"), false);
  assert.equal(operator.state().phase, "planning");
  assert.equal(operator.state().status, "inactive");
  assert.equal(operator.state().pendingRound, null);
  assert.equal(operator.state().cycle, 1);
});

test("reload while automatic compaction is still pending pauses without retry or projection", async () => {
  const branch = [];
  const first = harness({ branch, specificationState: "existing", planState: "existing", sessionId: "automatic-pending-reload" }); const initial = await startExecution(first);
  first.addGoal({ goalId: "goal-pending", status: "active", active: true });
  await control(first, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 }); await first.emit("turn_end", finalEvent("finished"));
  await first.handlers.get("context").at(-1)({ messages: [{ role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-pending", continuationsUsed: 1 } }] }, first.ctx);
  assert.equal(first.state().pendingRound.stage, "compacting");
  const rebuilt = harness({ branch, specificationState: "existing", planState: "existing", sessionId: "automatic-pending-reload" });
  await rebuilt.emit("session_start", { reason: "reload" });
  assert.equal(rebuilt.state().status, "paused"); assert.equal(rebuilt.state().pendingRound.stage, "failed");
  assert.equal(rebuilt.compactions.length, 0); assert.equal(rebuilt.sent.length, 0);
});

test("automatic boundary survives an unrelated queued context before exact admission", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  const initial = await startExecution(h);
  h.addGoal({ goalId: "goal-queued-context", status: "active", active: true });
  await control(h, { action: "continue", lifecycleId: initial.lifecycleId, cycle: 1 });
  await h.emit("turn_end", finalEvent("closed before queued context"));
  const goalMessage = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-queued-context", continuationsUsed: 1 } };
  await h.handlers.get("context").at(-1)({ messages: [goalMessage] }, h.ctx);
  const pending = h.state().pendingRound;
  const marker = [...h.branch].reverse().find((entry) => entry?.customType === "prime_ralph_reset_marker" && entry.data?.requestId === pending.requestId);
  const sentBefore = h.sent.length;
  h.compactions.at(-1).onComplete({ summary: "", firstKeptEntryId: marker.id });
  assert.equal(h.sent.length, sentBefore + 1);
  const boundary = h.sent[sentBefore].message;
  const unrelated = await h.handlers.get("context").at(-1)({ messages: [{ role: "user", content: "queued before boundary" }] }, h.ctx);
  assert.deepEqual(unrelated.messages, []);
  assert.equal(h.state().pendingRound.stage, "admission-requested");
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", content: [] }] });
  h.setSignalAvailable(false); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, sentBefore + 2);
  const release = h.sent[sentBefore + 1].message;
  h.setSignalAvailable(true); await h.emit("agent_start", {});
  await h.emit("message_start", { message: { role: "custom", ...release } });
  await h.emit("context", { messages: [{ role: "custom", ...boundary }, { role: "custom", ...release }] });
  assert.equal(h.state().cycle, 2);
  assert.equal(h.state().pendingRound, null);
});

test("automatic boundary admission append failure aborts before provider context", async () => {
  const p = harness({ specificationState: "existing", planState: "existing" });
  const pInitial = await startExecution(p);
  p.addGoal({ goalId: "goal-persistent", status: "active", active: true });
  await control(p, { action: "continue", lifecycleId: pInitial.lifecycleId, cycle: 1 });
  await p.emit("turn_end", finalEvent("closed for commit failure"));
  const pGoal = { role: "custom", customType: "goal_context", content: "continue", details: { kind: "continuation", goalId: "goal-persistent", continuationsUsed: 1 } };
  await p.handlers.get("context").at(-1)({ messages: [pGoal] }, p.ctx);
  const pending = p.state().pendingRound;
  const marker = [...p.branch].reverse().find((entry) => entry?.customType === "prime_ralph_reset_marker" && entry.data?.requestId === pending.requestId);
  p.compactions.at(-1).onComplete({ summary: "", firstKeptEntryId: marker.id });
  const pBoundary = p.sent.at(-1).message;
  await p.emit("message_start", { message: { role: "custom", ...pBoundary } });
  p.failAllStateAppends();
  const result = await p.handlers.get("context").at(-1)({ messages: [{ role: "custom", ...pBoundary }] }, p.ctx);
  assert.deepEqual(result?.messages ?? [], []);
  assert.ok(p.aborted() >= 1);
  assert.equal(p.state().cycle, 1);
  assert.equal(p.state().pendingRound.stage, "admission-requested");
  p.restoreStateAppends();
  const later = await p.handlers.get("context").at(-1)({ messages: [{ role: "user", content: "later user probe" }] }, p.ctx);
  assert.deepEqual(later.messages, []);
  assert.equal(p.state().cycle, 1);
  assert.equal(p.state().status, "running");
  assert.equal(p.state().pendingRound.stage, "admission-requested");
});

test("all stale automatic reset messages are denied by default", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" });
  await startExecution(h);
  const stale = { role: "custom", customType: RESET_MESSAGE_TYPE, content: "stale", details: { source: "prime-ralph", protocolVersion: 1, command: "execute-round", requestId: "stale", automaticCompactionRequestId: "stale", workflowPhase: "execution" } };
  await h.emit("message_start", { message: stale });
  assert.equal(h.aborted(), 1);
});

test("stale or replaced native goal continuations fail closed despite a later auxiliary custom message", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); await startExecution(h); h.addGoal({ goalId: "current", status: "active", active: true });
  const stale = { role: "custom", customType: "goal_context", content: "old", details: { kind: "continuation", goalId: "old", continuationsUsed: 4 } };
  const auxiliary = { role: "custom", customType: "acceptance_auxiliary", content: "extension context", details: { source: "before-agent-start" } };
  const result = await h.handlers.get("context").at(-1)({ messages: [stale, auxiliary] }, h.ctx);
  assert.deepEqual(result.messages, []); assert.equal(h.state().status, "paused"); assert.equal(h.aborted(), 1);
});

test("running context without a primary input or goal continuation remains unchanged", async () => {
  const h = harness({ specificationState: "existing", planState: "existing" }); await startExecution(h);
  const projected = await h.handlers.get("context").at(-1)({ messages: [{ role: "assistant", content: "prior" }, { role: "custom", customType: "acceptance_auxiliary", content: "extension context" }] }, h.ctx);
  assert.equal(projected, undefined);
  assert.equal(h.aborted(), 0);
  assert.equal(h.state().status, "running");
});
