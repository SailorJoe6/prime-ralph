import test from "node:test";
import assert from "node:assert/strict";
import { BeadsCoordinator, runQualityGates } from "../src/beads-coordination.js";

function fixture() { let time = 1000; const c = new BeadsCoordinator({ leaseMs: 100, now: () => time }); c.addIssue({ id: "low", priority: 2 }); c.addIssue({ id: "high", priority: 1 }); return { c, advance: (n) => { time += n; } }; }

test("selects highest priority and enforces one active lease", () => { const { c } = fixture(); assert.equal(c.selectNext().id, "high"); c.claim("high", "session-a"); assert.throws(() => c.claim("high", "session-b"), /already leased/); });
test("stale lease can be reclaimed and old owner cannot checkpoint", () => { const { c, advance } = fixture(); c.claim("high", "a"); advance(101); c.claim("high", "b"); assert.throws(() => c.checkpoint("high", "a", "late"), /stale|not owned/); });
test("checkpoint refreshes lease and close requires evidence", () => { const { c, advance } = fixture(); c.claim("high", "a"); const evidence = c.checkpoint("high", "a", { result: "ok", secret: "hidden", owner: "x@example.com" }); assert.equal(evidence.secret, undefined); assert.match(evidence.owner, /redacted/); advance(99); c.checkpoint("high", "a", "still alive"); assert.throws(() => c.close("high", "a"), /evidence/); const closed = c.close("high", "a", "tests passed"); assert.equal(closed.status, "closed"); assert.equal(c.selectNext().id, "low"); });
test("quality gates report every result and fail closed", () => { const result = runQualityGates([function tests() { return true; }, function lint() { throw new Error("bad"); }]); assert.equal(result.passed, false); assert.deepEqual(result.results.map((r) => r.passed), [true, false]); });
