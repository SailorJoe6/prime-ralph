import test from "node:test";
import assert from "node:assert/strict";
import {
  hasResetBoundary,
  hasResetCompaction,
  latestResetState,
  projectResetContext,
  resetCompactionInstructions,
  RESET_MESSAGE_TYPE,
  RESET_PROTOCOL_VERSION,
  RESET_STATE_TYPE,
} from "../src/reset-context.js";

const details = { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: "r1" };

test("removes only a matching Ralph empty compaction wrapper", () => {
  const wrapper = { role: "compactionSummary", summary: "", customInstructions: resetCompactionInstructions("r1") };
  const prepare = { role: "custom", customType: RESET_MESSAGE_TYPE, content: "prepare", details: { ...details, mode: "compaction" } };
  const after = { role: "assistant", content: "after" };
  assert.deepEqual(projectResetContext([wrapper, prepare, after]), [prepare, after]);
  assert.deepEqual(projectResetContext([{ ...wrapper, summary: "ordinary" }]), [{ ...wrapper, summary: "ordinary" }]);
  assert.deepEqual(projectResetContext([{ ...wrapper, customInstructions: "user compact" }]), [{ ...wrapper, customInstructions: "user compact" }]);
});

test("projects only the latest short-session fallback boundary", () => {
  const stale = [{ role: "user", content: "old" }];
  const compactPrepare = { role: "custom", customType: RESET_MESSAGE_TYPE, content: "compact", details: { ...details, mode: "compaction" } };
  const fallback = { role: "custom", customType: RESET_MESSAGE_TYPE, content: "fallback", details: { ...details, requestId: "r2", mode: "projection-fallback" } };
  const after = { role: "assistant", content: "after" };
  assert.deepEqual(projectResetContext([...stale, compactPrepare, after]), [compactPrepare, after]);
  assert.deepEqual(projectResetContext([...stale, compactPrepare, after, fallback]), [fallback]);
});

test("recognizes only versioned Ralph state, boundary, and compaction entries", () => {
  const entries = [
    { type: "custom", customType: RESET_STATE_TYPE, data: { ...details, status: "compacting" } },
    { type: "compaction", summary: "", customInstructions: resetCompactionInstructions("r1") },
    { type: "custom_message", customType: RESET_MESSAGE_TYPE, details },
  ];
  assert.equal(latestResetState(entries).status, "compacting");
  assert.equal(hasResetBoundary(entries, "r1"), true);
  assert.equal(hasResetCompaction(entries, "r1"), true);
  assert.equal(hasResetBoundary(entries, "other"), false);
  assert.equal(hasResetCompaction(entries, "other"), false);
});
