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

export async function executeClaimedCycle({ bd, issueId, metadata, phase, gates = [], evidence } = {}) {
  const claim = await bd.claim(issueId);
  const gateResult = runQualityGates(gates, { phase, issueId, metadata });
  if (!gateResult.passed) return { status: "gate_failed", claim, gates: gateResult };
  if (evidence === undefined || evidence === null || evidence === "") throw new Error("durable evidence is required");
  const checkpoint = await bd.checkpoint(issueId, JSON.stringify({ ...metadata, phase, evidence }));
  return { status: "checkpointed", claim, gates: gateResult, checkpoint };
}

export async function startManagedCycle({ bd, issueId, metadata, phase, gates = [], evidence } = {}) {
  const result = await executeClaimedCycle({ bd, issueId, metadata, phase, gates, evidence });
  return { ...result, ownership: { issueId, sessionId: metadata?.sessionId ?? null, cycleId: metadata?.cycleId ?? null } };
}
