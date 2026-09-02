import { runQualityGates } from "./beads-coordination.js";

export function buildOwnershipMetadata({ sessionId, cycleId, actor = "agent" } = {}) {
  if (!sessionId || !cycleId) throw new Error("sessionId and cycleId are required");
  return { sessionId: String(sessionId), cycleId: String(cycleId), actor: String(actor) };
}

export function claimForCycle(beads, issueId, metadata) {
  const lease = beads.claim(issueId, metadata.sessionId);
  return { issueId, ...metadata, leaseExpiresAt: lease.expiresAt };
}

export function runPhaseGates(gatesByPhase, phase, context = {}) {
  const gates = gatesByPhase?.[phase] ?? [];
  return runQualityGates(gates, { ...context, phase });
}
