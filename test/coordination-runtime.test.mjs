import test from "node:test";
import assert from "node:assert/strict";
import { BeadsCoordinator } from "../src/beads-coordination.js";
import { buildOwnershipMetadata, claimForCycle, runPhaseGates } from "../src/coordination-runtime.js";

test("ownership metadata carries session and cycle without changing actor semantics", () => { const m = buildOwnershipMetadata({ sessionId: "session-1", cycleId: 3, actor: "joe" }); assert.deepEqual(m, { sessionId: "session-1", cycleId: "3", actor: "joe" }); assert.throws(() => buildOwnershipMetadata({ cycleId: 1 }), /required/); });
test("claim metadata binds the lease to the current cycle", () => { const c = new BeadsCoordinator({ now: () => 1000 }); c.addIssue({ id: "i", priority: 1 }); const m = claimForCycle(c, "i", buildOwnershipMetadata({ sessionId: "s", cycleId: 1 })); assert.equal(m.issueId, "i"); assert.equal(m.sessionId, "s"); assert.equal(typeof m.leaseExpiresAt, "number"); });
test("phase gates are selected by configuration and fail closed", () => { const result = runPhaseGates({ execute: [function tests(ctx) { return ctx.phase === "execute"; }], plan: [function fail() { return false; }] }, "execute"); assert.equal(result.passed, true); assert.equal(runPhaseGates({ plan: [() => false] }, "plan").passed, false); });
