import test from "node:test";
import assert from "node:assert/strict";
import {
  hasResetBoundary,
  hasResetCompaction,
  latestResetState,
  latestResetStateForRequest,
  resetCompactionInstructions,
  RESET_MESSAGE_TYPE,
  RESET_PROTOCOL_VERSION,
  RESET_STATE_TYPE,
} from "../src/reset-context.js";

const details = { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: "r1" };

test("recognizes only versioned Ralph state, boundary, and compaction entries", () => {
  const entries = [
    { type: "custom", customType: RESET_STATE_TYPE, data: { ...details, status: "compacting" } },
    { type: "compaction", summary: "", customInstructions: resetCompactionInstructions("r1") },
    { type: "custom_message", customType: RESET_MESSAGE_TYPE, details },
  ];
  entries.push({ type: "custom", customType: RESET_STATE_TYPE, data: { ...details, requestId: "r2", status: "failed" } });
  assert.equal(latestResetState(entries).status, "failed");
  assert.equal(latestResetStateForRequest(entries, "r1").status, "compacting");
  assert.equal(hasResetBoundary(entries, "r1"), true);
  assert.equal(hasResetCompaction(entries, "r1"), true);
  assert.equal(hasResetBoundary(entries, "other"), false);
  assert.equal(hasResetCompaction(entries, "other"), false);
});
