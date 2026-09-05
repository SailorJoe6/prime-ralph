import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTION_COMPACTION_MARKER_TYPE,
  executionCompactionInstructions,
  executionCompactionRequestId,
  hasExecutionBoundary,
  hasExecutionCompaction,
  isExecutionCompactionMarker,
  isExecutionCompactionSummary,
  latestExecutionCompactionMarker,
} from "../src/execution-boundary-compaction.js";

const marker = (overrides = {}) => ({
  type: "custom", id: "marker-1", customType: EXECUTION_COMPACTION_MARKER_TYPE,
  data: { source: "prime-ralph", protocolVersion: 1, requestId: "request-1", sessionId: "session", lifecycleId: "life", cycle: 2, goalId: "goal", continuationsUsed: 1, boundaryIdentity: "goal:1", ...overrides },
});

test("execution compaction instructions use a separate exact request namespace", () => {
  const instructions = executionCompactionInstructions("request-1");
  assert.equal(executionCompactionRequestId(instructions), "request-1");
  assert.equal(executionCompactionRequestId("prime-ralph-reset:v2:request-1"), undefined);
  assert.equal(executionCompactionRequestId("ordinary compaction"), undefined);
  assert.throws(() => executionCompactionInstructions(""), /requestId/);
});

test("execution compaction markers require exact durable correlation", () => {
  const value = marker();
  assert.equal(isExecutionCompactionMarker(value, { requestId: "request-1", lifecycleId: "life", boundaryIdentity: "goal:1" }), true);
  assert.equal(isExecutionCompactionMarker(value, { lifecycleId: "other" }), false);
  assert.equal(isExecutionCompactionMarker({ ...value, id: undefined }), false);
  assert.equal(latestExecutionCompactionMarker([marker({ requestId: "old" }), value], { boundaryIdentity: "goal:1" }), value);
});

test("durable compaction and resumed boundary predicates reject near matches", () => {
  const correlation = { requestId: "request-1", markerId: "marker-1", sessionId: "session", lifecycleId: "life", cycle: 2, goalId: "goal", continuationsUsed: 1, boundaryIdentity: "goal:1" };
  const compaction = { type: "compaction", summary: "", firstKeptEntryId: "marker-1", customInstructions: executionCompactionInstructions("request-1") };
  assert.equal(hasExecutionCompaction([marker(), compaction], correlation), true);
  assert.equal(hasExecutionCompaction([marker({ lifecycleId: "other" }), compaction], correlation), false);
  assert.equal(hasExecutionCompaction([marker(), { ...compaction, firstKeptEntryId: "other" }], correlation), false);
  const boundary = { type: "custom_message", customType: "prime_ralph_execution_skill", details: { source: "prime-ralph", protocolVersion: 1, automaticCompactionRequestId: "request-1", sessionId: "session", lifecycleId: "life", cycle: 2, goalId: "goal", continuationsUsed: 1, boundaryIdentity: "goal:1" } };
  assert.equal(hasExecutionBoundary([boundary], correlation), true);
  for (const [field, value] of [["protocolVersion", 2], ["lifecycleId", "other"], ["cycle", 3], ["goalId", "other"], ["continuationsUsed", 2], ["boundaryIdentity", "goal:2"]]) {
    assert.equal(hasExecutionBoundary([{ ...boundary, details: { ...boundary.details, [field]: value } }], correlation), false);
  }
  assert.equal(isExecutionCompactionSummary({ role: "compactionSummary", summary: "", customInstructions: executionCompactionInstructions("request-1") }, "request-1"), true);
  assert.equal(isExecutionCompactionSummary({ role: "compactionSummary", summary: "", customInstructions: "prime-ralph-reset:v2:request-1" }, "request-1"), false);
});
