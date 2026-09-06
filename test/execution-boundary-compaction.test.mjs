import test from "node:test";
import assert from "node:assert/strict";
import {
  executionCompactionInstructions,
  executionCompactionRequestId,
  isExecutionCompactionSummary,
} from "../src/execution-boundary-compaction.js";

test("execution compaction instructions carry one bounded exact request ID", () => {
  const instructions = executionCompactionInstructions("request-1");
  assert.equal(executionCompactionRequestId(instructions), "request-1");
  assert.equal(executionCompactionRequestId("ordinary compaction"), undefined);
  assert.equal(executionCompactionRequestId(executionCompactionInstructions("x".repeat(200))), "x".repeat(200));
  assert.equal(executionCompactionRequestId(`prime-ralph-execution-boundary:v1:${"x".repeat(201)}`), undefined);
  assert.throws(() => executionCompactionInstructions(""), /1 to 200/);
  assert.throws(() => executionCompactionInstructions("x".repeat(201)), /1 to 200/);
});

test("execution summary matching is exact and leaves ordinary compaction alone", () => {
  const summary = { role: "compactionSummary", summary: "", customInstructions: executionCompactionInstructions("request-1") };
  assert.equal(isExecutionCompactionSummary(summary, "request-1"), true);
  assert.equal(isExecutionCompactionSummary(summary, "request-2"), false);
  assert.equal(isExecutionCompactionSummary({ ...summary, summary: "generated" }, "request-1"), false);
  assert.equal(isExecutionCompactionSummary({ ...summary, role: "user" }, "request-1"), false);
});
