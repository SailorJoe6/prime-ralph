import test from "node:test";
import assert from "node:assert/strict";
import { createContinuationAdapter } from "../src/continuation-adapter.js";

test("admits one continuation only after compaction settles", async () => {
  const calls = []; const jobs = [];
  const a = createContinuationAdapter({ sendMessage: (...args) => { calls.push(args); return Promise.resolve(); }, schedule: (fn) => jobs.push(fn) });
  assert.equal(a.settle({ activeGoal: true }), true); assert.equal(calls.length, 0); jobs.shift()(); await Promise.resolve();
  assert.equal(calls.length, 1); assert.equal(calls[0][0].customType, "goal_context"); assert.equal(a.settle(), false); assert.equal(a.snapshot().admitted, true);
});

test("cancellation prevents deferred admission and inactive goals queue nothing", () => {
  const jobs = []; let calls = 0;
  const a = createContinuationAdapter({ sendMessage: () => { calls += 1; }, schedule: (fn) => jobs.push(fn) });
  assert.equal(a.settle({ activeGoal: false }), false); assert.equal(a.settle(), true); a.cancel(); jobs.shift()(); assert.equal(calls, 0); assert.equal(a.snapshot().cancelled, true);
});

test("send failures are reported without permitting a second admission", async () => {
  const jobs = [], errors = [];
  const a = createContinuationAdapter({ sendMessage: () => Promise.reject(new Error("provider unavailable")), schedule: (fn) => jobs.push(fn), onError: (e) => errors.push(e.message) });
  a.settle(); jobs.shift()(); await Promise.resolve(); await Promise.resolve(); assert.deepEqual(errors, ["provider unavailable"]); assert.equal(a.snapshot().admitted, true);
});
