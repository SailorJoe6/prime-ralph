import test from "node:test";
import assert from "node:assert/strict";
import { BeadsCoordinator } from "../src/beads-coordination.js";
import { GoalLifecycle } from "../src/goal-lifecycle.js";

test("heartbeat renews owned lease and terminal transition releases it", () => { let now = 1000; const beads = new BeadsCoordinator({ leaseMs: 100, now: () => now }); beads.addIssue({ id: "i" }); beads.claim("i", "s"); const g = new GoalLifecycle({ beads, issueId: "i", sessionId: "s", cycleId: 1 }); now = 1050; assert.equal(g.heartbeat(), true); assert.equal(beads.issues.get("i").lease.expiresAt, 1150); const event = g.transition("complete", { result: "ok", email: "a@example.com" }); assert.equal(event.status, "complete"); assert.equal(beads.issues.get("i").lease, null); assert.equal(g.heartbeat(), false); });
test("heartbeat fails closed for a stolen lease and status details are sanitized", () => { const beads = new BeadsCoordinator({ now: () => 1000 }); beads.addIssue({ id: "i" }); beads.claim("i", "a"); assert.throws(() => new GoalLifecycle({ beads, issueId: "i", sessionId: "b" }).heartbeat(), /not owned/); const g = new GoalLifecycle({ beads, issueId: "i", sessionId: "a", cycleId: 2 }); const event = g.transition("error", { secret: "x", contact: "a@example.com" }); assert.doesNotMatch(JSON.stringify(event), /x|a@example.com/); });
