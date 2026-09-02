import test from "node:test";
import assert from "node:assert/strict";
import { RalphCycleCoordinator } from "../src/cycle-coordinator.js";

test("runs a cycle and explicitly queues continuation after compaction", () => {
  const markers = [];
  const c = new RalphCycleCoordinator({ appendMarker: (m) => markers.push(m) });
  c.begin(); c.executing(); c.checkpoint({ issue: "task-1" }); c.compacting("marker-1");
  assert.equal(c.compacted({ boundaryId: "marker-1" }).state, "rehydrating");
  assert.equal(c.snapshot().continuationQueued, true);
  assert.equal(markers.filter((m) => m.kind === "goal_continuation").length, 1);
  c.resumed(); assert.equal(c.snapshot().state, "executing");
});

test("does not queue continuation when the goal is no longer active", () => {
  const c = new RalphCycleCoordinator({ activeGoal: () => false });
  c.begin(); c.executing(); c.checkpoint(); c.compacting("m");
  c.compacted({ boundaryId: "m" });
  assert.equal(c.snapshot().continuationQueued, false);
});

test("rejects duplicate or mismatched compaction boundaries", () => {
  const c = new RalphCycleCoordinator(); c.begin(); c.executing(); c.checkpoint(); c.compacting("m");
  assert.throws(() => c.compacted({ boundaryId: "other" }), /does not match/);
  c.compacted({ boundaryId: "m" });
  assert.throws(() => c.compacted({ boundaryId: "m" }), /invalid Ralph cycle transition/);
});

test("failure marker is sanitized and restart begins a new cycle", () => {
  const markers = []; const c = new RalphCycleCoordinator({ appendMarker: (m) => markers.push(m) });
  c.begin(); c.executing(); c.fail(new Error("provider secret=do-not-copy alice@example.com"));
  assert.equal(c.snapshot().state, "error");
  assert.match(JSON.stringify(markers), /redacted-email/); assert.doesNotMatch(JSON.stringify(markers), /alice@example.com|do-not-copy/);
  c.begin(); assert.deepEqual(c.snapshot(), { state: "preparing", cycleId: 2, compactedBoundary: null, continuationQueued: false });
});

test("restart recovery records an incomplete cycle instead of silently continuing", () => {
  const markers = []; const c = new RalphCycleCoordinator({ appendMarker: (m) => markers.push(m) });
  c.begin(); c.executing(); c.checkpoint(); c.compacting("boundary-1");
  assert.equal(c.recover("process restarted during compaction").state, "error");
  assert.match(JSON.stringify(markers), /process restarted during compaction/);
  c.begin(); assert.equal(c.snapshot().cycleId, 2);
});

test("recovery is idempotent after a terminal failure", () => {
  const c = new RalphCycleCoordinator(); c.begin(); c.executing(); c.fail("provider error");
  assert.deepEqual(c.recover(), c.snapshot());
});
