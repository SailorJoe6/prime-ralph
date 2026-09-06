import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTION_COMPACTION_MARKER_TYPE,
  executionCompactionInstructions,
  executionCompactionRequestId,
  hasExecutionBoundary,
  hasExecutionCompaction,
  inspectExecutionCompactionRecovery,
  isExecutionCompactionMarker,
  isExecutionCompactionSummary,
  latestExecutionCompactionMarker,
} from "../src/execution-boundary-compaction.js";

const correlation = Object.freeze({
  requestId: "request-1", markerId: "marker-1", sessionId: "session-1", lifecycleId: "life-1",
  cycle: 2, goalId: "goal-1", continuationsUsed: 1, boundaryIdentity: "goal-1:1",
});
const marker = (overrides = {}) => ({
  type: "custom", id: correlation.markerId, customType: EXECUTION_COMPACTION_MARKER_TYPE,
  data: { source: "prime-ralph", protocolVersion: 1, requestId: correlation.requestId,
    sessionId: correlation.sessionId, lifecycleId: correlation.lifecycleId, cycle: correlation.cycle,
    goalId: correlation.goalId, continuationsUsed: correlation.continuationsUsed,
    boundaryIdentity: correlation.boundaryIdentity, ...overrides },
});
const compaction = (overrides = {}) => ({
  type: "compaction", id: "compaction-1", summary: "", firstKeptEntryId: correlation.markerId,
  customInstructions: executionCompactionInstructions(correlation.requestId), ...overrides,
});
const boundary = (overrides = {}) => ({
  type: "custom_message", id: "boundary-1", customType: "prime_ralph_execution_skill",
  details: { source: "prime-ralph", protocolVersion: 1,
    automaticCompactionRequestId: correlation.requestId, sessionId: correlation.sessionId,
    lifecycleId: correlation.lifecycleId, cycle: correlation.cycle, goalId: correlation.goalId,
    continuationsUsed: correlation.continuationsUsed, boundaryIdentity: correlation.boundaryIdentity,
    ...overrides },
});

const correlationFields = [
  ["requestId", "other-request"], ["sessionId", "other-session"], ["lifecycleId", "other-life"],
  ["cycle", 3], ["goalId", "other-goal"], ["continuationsUsed", 2], ["boundaryIdentity", "goal-1:2"],
];

test("execution compaction instructions carry one bounded exact request ID", () => {
  const instructions = executionCompactionInstructions("request-1");
  assert.equal(executionCompactionRequestId(instructions), "request-1");
  assert.equal(executionCompactionRequestId("prime-ralph-reset:v2:request-1"), undefined);
  assert.equal(executionCompactionRequestId("ordinary compaction"), undefined);
  assert.equal(executionCompactionRequestId(executionCompactionInstructions("x".repeat(200))), "x".repeat(200));
  assert.equal(executionCompactionRequestId(`prime-ralph-execution-boundary:v1:${"x".repeat(201)}`), undefined);
  assert.throws(() => executionCompactionInstructions(""), /1 to 200/);
  assert.throws(() => executionCompactionInstructions("x".repeat(201)), /1 to 200/);
});

test("execution compaction markers require a complete exact durable identity", () => {
  const value = marker();
  assert.equal(isExecutionCompactionMarker(value, correlation), true);
  assert.equal(latestExecutionCompactionMarker([marker({ requestId: "old" }), value], correlation), value);
  assert.equal(latestExecutionCompactionMarker(JSON.parse(JSON.stringify([value])), correlation)?.id, correlation.markerId);
  for (const malformedCorrelation of [undefined, null, [], "request-1", {}, { requestId: "request-1" }]) {
    assert.equal(isExecutionCompactionMarker(value, malformedCorrelation), false);
    assert.equal(latestExecutionCompactionMarker([value], malformedCorrelation), undefined);
  }
  for (const field of correlationFields.map(([name]) => name)) {
    const incomplete = { ...correlation };
    delete incomplete[field];
    assert.equal(isExecutionCompactionMarker(value, incomplete), false, `missing ${field}`);
  }
  for (const [field, changed] of correlationFields) {
    assert.equal(isExecutionCompactionMarker(value, { ...correlation, [field]: changed }), false, field);
  }
  assert.equal(isExecutionCompactionMarker(value, { ...correlation, markerId: "other-marker" }), false);
  const malformed = [
    ["requestId", ""], ["sessionId", ""], ["lifecycleId", ""], ["cycle", 0],
    ["goalId", ""], ["continuationsUsed", -1], ["boundaryIdentity", "not-the-goal-epoch"],
  ];
  for (const [field, changed] of malformed) {
    assert.equal(isExecutionCompactionMarker(marker({ [field]: changed }), correlation), false, `invalid marker ${field}`);
  }
  assert.equal(isExecutionCompactionMarker({ ...value, id: "" }, correlation), false);
  assert.equal(isExecutionCompactionMarker({ ...value, customType: "other" }, correlation), false);
  assert.equal(latestExecutionCompactionMarker([value, { ...value, id: "marker-duplicate" }], correlation), undefined);
});

test("recovery inspection distinguishes durable stages and malformed input without throwing", () => {
  const state = (entries, expected) => inspectExecutionCompactionRecovery(entries, expected).state;
  for (const malformedEntries of [undefined, null, {}, "branch"]) {
    assert.equal(state(malformedEntries, correlation), "invalid");
  }
  for (const malformed of [undefined, null, [], "request-1", {}, { requestId: "request-1" }, { ...correlation, requestId: "x".repeat(201) }]) {
    assert.equal(state([], malformed), "invalid");
  }
  assert.equal(state([], correlation), "absent");
  assert.equal(state([compaction()], correlation), "ambiguous");
  assert.equal(state([boundary()], correlation), "ambiguous");
  assert.equal(state([marker()], correlation), "marker-only");
  assert.equal(state([marker(), boundary()], correlation), "ambiguous");
  assert.equal(state([marker(), { type: "custom_message", id: "unrelated" }, compaction()], correlation), "compacted");
  assert.equal(state([marker(), boundary(), compaction()], correlation), "ambiguous");
  assert.equal(state([marker(), compaction(), { type: "custom_message", id: "unrelated" }, boundary()], correlation), "resumed");
  assert.equal(state(JSON.parse(JSON.stringify([marker(), compaction(), boundary()])), correlation), "resumed");
  assert.equal(state([marker(), compaction({ id: "" })], correlation), "ambiguous");
  assert.equal(state([marker(), compaction(), { ...boundary(), id: "" }], correlation), "ambiguous");
});

test("durable compaction detection requires exact marker-first branch ordering", () => {
  assert.equal(hasExecutionCompaction([marker(), compaction()], correlation), true);
  assert.equal(hasExecutionCompaction(JSON.parse(JSON.stringify([marker(), compaction()])), correlation), true);
  assert.equal(hasExecutionCompaction([compaction(), marker()], correlation), false);
  assert.equal(hasExecutionCompaction([marker(), compaction({ summary: "generated" })], correlation), false);
  assert.equal(hasExecutionCompaction([marker(), compaction({ firstKeptEntryId: "other-marker" })], correlation), false);
  assert.equal(hasExecutionCompaction([marker(), compaction({ customInstructions: "prime-ralph-reset:v2:request-1" })], correlation), false);
  assert.equal(hasExecutionCompaction([marker(), marker({ lifecycleId: "forked-life" }), compaction()], correlation), false);
  assert.equal(hasExecutionCompaction([marker(), compaction(), compaction()], correlation), false);
  assert.equal(hasExecutionCompaction([marker(), compaction({ firstKeptEntryId: "other-marker" }), compaction()], correlation), false);
  for (const [field, changed] of correlationFields) {
    assert.equal(hasExecutionCompaction([marker(), compaction()], { ...correlation, [field]: changed }), false, field);
  }
});

test("resumed execution boundary detection requires exact post-compaction correlation", () => {
  const branch = [marker(), compaction(), boundary()];
  assert.equal(hasExecutionBoundary(branch, correlation), true);
  assert.equal(hasExecutionBoundary(JSON.parse(JSON.stringify(branch)), correlation), true);
  assert.equal(hasExecutionBoundary([marker(), boundary(), compaction()], correlation), false);
  assert.equal(hasExecutionBoundary([marker(), compaction()], correlation), false);
  for (const [field, changed] of correlationFields) {
    const detailField = field === "requestId" ? "automaticCompactionRequestId" : field;
    assert.equal(hasExecutionBoundary([marker(), compaction(), boundary({ [detailField]: changed })], correlation), false, field);
  }
  assert.equal(hasExecutionBoundary([marker(), compaction(), { ...boundary(), customType: "other" }], correlation), false);
  assert.equal(hasExecutionBoundary([marker(), compaction(), boundary(), boundary()], correlation), false);
  assert.equal(hasExecutionBoundary([marker(), compaction(), boundary(), boundary({ cycle: 3 })], correlation), false);
});

test("execution summary matching is exact and leaves ordinary compaction alone", () => {
  const summary = { role: "compactionSummary", summary: "", customInstructions: executionCompactionInstructions("request-1") };
  assert.equal(isExecutionCompactionSummary(summary, "request-1"), true);
  assert.equal(isExecutionCompactionSummary(summary, "request-2"), false);
  assert.equal(isExecutionCompactionSummary({ ...summary, summary: "generated" }, "request-1"), false);
  assert.equal(isExecutionCompactionSummary({ ...summary, role: "user" }, "request-1"), false);
  assert.equal(isExecutionCompactionSummary({ role: "compactionSummary", summary: "", customInstructions: "ordinary" }, undefined), false);
});
