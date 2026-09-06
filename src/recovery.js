import {
  RESET_MARKER_TYPE, RESET_MESSAGE_TYPE, RESET_PROTOCOL_VERSION, RESET_STATE_TYPE,
} from "./reset-context.js";
import { EXECUTION_STATE_ENTRY_TYPE } from "./execution.js";

export const RECOVERY_PROTOCOL_VERSION = 1;
export const RECOVERY_STATE_TYPE = "prime_ralph_recovery_state";
export const RECOVERY_STATUS = "navigation-verified";
const LEGACY_RESET_PROTOCOL_VERSION = 2;
const RECOVERABLE_RESET_PROTOCOLS = new Set([LEGACY_RESET_PROTOCOL_VERSION, RESET_PROTOCOL_VERSION]);
const recoveryCompactionInstructions = (version, requestId) => `prime-ralph-reset:v${version}:${requestId}`;

export class RalphRecoveryError extends Error {
  constructor(message) { super(message); this.name = "RalphRecoveryError"; }
}

const text = (value, maximum = 200) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const exactOne = (values, label) => {
  if (values.length !== 1) throw new RalphRecoveryError(`Ralph recovery requires exactly one ${label}; found ${values.length}`);
  return values[0];
};

export function branchForLeaf(entries, leafId) {
  if (!Array.isArray(entries) || !text(leafId)) throw new RalphRecoveryError("Ralph recovery requires a valid session leaf");
  const byId = new Map();
  for (const entry of entries) {
    if (!text(entry?.id) || byId.has(entry.id)) throw new RalphRecoveryError("Ralph recovery found missing or duplicate session entry identity");
    byId.set(entry.id, entry);
  }
  const result = [], seen = new Set();
  let id = leafId;
  while (id != null) {
    if (seen.has(id)) throw new RalphRecoveryError("Ralph recovery found a cyclic session tree");
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new RalphRecoveryError("Ralph recovery found a missing session ancestor");
    result.push(entry); id = entry.parentId;
  }
  return result.reverse();
}

function targetableAnchor(marker, branch, entriesById) {
  if (!text(marker?.parentId)) throw new RalphRecoveryError("Ralph recovery marker has no safe parent anchor");
  const anchor = entriesById.get(marker.parentId);
  if (!anchor || !branch.some((entry) => entry.id === anchor.id)) throw new RalphRecoveryError("Ralph recovery anchor is missing from the exact branch");
  const exactTargetTypes = new Set(["message", "custom", "compaction", "branch_summary", "thinking_level_change", "service_tier_change", "model_change", "child_usage_attributed", "label", "session_info", "session_state", "agent_status", "git_state"]);
  if (!exactTargetTypes.has(anchor.type) || anchor.type === "custom_message" || (anchor.type === "message" && anchor.message?.role === "user")) {
    throw new RalphRecoveryError("Ralph recovery anchor has unsafe edit semantics");
  }
  return anchor;
}

function requestBundle(branch, entriesById, requestId, { poisoned }) {
  if (!text(requestId)) throw new RalphRecoveryError("Ralph recovery found an invalid reset request identity");
  const marker = exactOne(branch.filter((entry) => entry?.type === "custom" && entry.customType === RESET_MARKER_TYPE &&
    entry.data?.source === "prime-ralph" && RECOVERABLE_RESET_PROTOCOLS.has(entry.data?.protocolVersion) && entry.data?.requestId === requestId), "matching reset marker");
  const resetVersion = marker.data.protocolVersion;
  const message = exactOne(branch.filter((entry) => entry?.type === "custom_message" && entry.customType === RESET_MESSAGE_TYPE && entry.display === false &&
    (typeof entry.content === "string" ? entry.content.trim().length > 0 : Array.isArray(entry.content) && entry.content.length > 0) &&
    entry.details?.source === "prime-ralph" && entry.details?.protocolVersion === resetVersion && entry.details?.requestId === requestId), "matching hidden reset message");
  const compaction = exactOne(branch.filter((entry) => entry?.type === "compaction" && entry.summary === "" &&
    entry.customInstructions === recoveryCompactionInstructions(resetVersion, requestId) && entry.firstKeptEntryId === marker.id && entry.details?.source === "prime-ralph" &&
    entry.details?.protocolVersion === resetVersion && entry.details?.requestId === requestId), "matching native compaction");
  const states = branch.filter((entry) => entry?.type === "custom" && entry.customType === RESET_STATE_TYPE &&
    entry.data?.source === "prime-ralph" && entry.data?.protocolVersion === resetVersion && entry.data?.requestId === requestId);
  const compacting = exactOne(states.filter((entry) => entry.data?.status === "compacting"), "compacting reset state");
  const prepared = exactOne(states.filter((entry) => entry.data?.status === "prepare_pending"), "prepare-pending reset state");
  const terminalStates = states.filter((entry) => poisoned === true ? ["failed", "interrupted"].includes(entry.data?.status) : poisoned === "historical" ? ["completed", "failed", "interrupted"].includes(entry.data?.status) : entry.data?.status === "completed");
  const terminal = exactOne(terminalStates, poisoned === true ? "poisoned terminal reset state" : poisoned === "historical" ? "historical root terminal reset state" : "completed root reset state");
  if (states.at(-1)?.id !== terminal.id) throw new RalphRecoveryError("Ralph recovery found ambiguous later reset state");
  const command = marker.data?.command;
  if (!text(command, 80) || message.details?.command !== command || compaction.details?.command !== command ||
      compacting.data?.command !== command || prepared.data?.command !== command || terminal.data?.command !== command) {
    throw new RalphRecoveryError("Ralph recovery found mismatched reset command evidence");
  }
  if (compacting.data?.markerId !== marker.id) throw new RalphRecoveryError("Ralph recovery found mismatched compacting marker identity");
  const correlationFields = ["workflowPhase", "invocationMode", "sessionId", "lifecycleId", "cycle", "provenanceId"];
  const evidenceRecords = [marker.data, compaction.details, compacting.data, prepared.data, terminal.data];
  const requiredFields = correlationFields.filter((field) => message.details?.[field] != null);
  if (resetVersion === RESET_PROTOCOL_VERSION) {
    if (!requiredFields.includes("workflowPhase") || !requiredFields.includes("invocationMode") || !requiredFields.includes("sessionId") ||
        evidenceRecords.some((evidence) => correlationFields.some((field) => evidence?.[field] !== message.details?.[field]))) {
      throw new RalphRecoveryError("Ralph recovery found missing or mismatched correlated reset evidence");
    }
  } else {
    for (const field of correlationFields) for (const evidence of evidenceRecords) {
      if (evidence?.[field] != null && evidence[field] !== message.details?.[field]) throw new RalphRecoveryError("Ralph recovery found mismatched correlated reset evidence");
    }
    if (message.details?.workflowPhase !== "execution") throw new RalphRecoveryError("Legacy Ralph recovery evidence is accepted only for an exact execution lifecycle");
  }
  const positions = [marker, compacting, compaction, prepared, message, terminal].map((entry) => branch.findIndex((candidate) => candidate.id === entry.id));
  if (!positions.every((position, index) => index === 0 || position > positions[index - 1])) throw new RalphRecoveryError("Ralph recovery found out-of-order reset evidence");
  if (poisoned === true) {
    const lastCompaction = branch.findLastIndex((entry) => entry?.type === "compaction");
    if (branch.findIndex((entry) => entry.id === message.id) < lastCompaction) throw new RalphRecoveryError("Ralph recovery boundary is not provider-visible");
  }
  return { requestId, command, marker, message, compaction, terminal, anchor: targetableAnchor(marker, branch, entriesById) };
}

export function findPoisonedRecoveryCandidate(branch, allEntries, sessionId) {
  if (!Array.isArray(branch) || !Array.isArray(allEntries) || !text(sessionId)) throw new RalphRecoveryError("Ralph recovery requires exact session evidence");
  const entriesById = new Map(allEntries.map((entry) => [entry?.id, entry]));
  const poisonStates = branch.filter((entry) => entry?.type === "custom" && entry.customType === RESET_STATE_TYPE &&
    entry.data?.source === "prime-ralph" && RECOVERABLE_RESET_PROTOCOLS.has(entry.data?.protocolVersion) && ["failed", "interrupted"].includes(entry.data?.status));
  const candidates = [], candidateErrors = [];
  const lastCompaction = branch.findLastIndex((entry) => entry?.type === "compaction");
  for (const state of poisonStates) {
    try {
      const bundle = requestBundle(branch, entriesById, state.data?.requestId, { poisoned: true });
      if (bundle.terminal.id !== state.id) continue;
      candidates.push(bundle);
    } catch (error) {
      if (!(error instanceof RalphRecoveryError)) throw error;
      const hasHiddenBoundary = branch.some((entry) => entry?.type === "custom_message" && entry.customType === RESET_MESSAGE_TYPE && entry.details?.source === "prime-ralph" && entry.details?.protocolVersion === state.data?.protocolVersion && entry.details?.requestId === state.data?.requestId);
      const preProviderFailure = !hasHiddenBoundary && state.data?.boundaryExists !== true && ["compaction_unavailable", "compaction_failed", "compaction_request_failed", "compaction_setup_failed", "skill_admission_failed"].includes(state.data?.reason);
      if (!preProviderFailure && branch.findIndex((entry) => entry.id === state.id) > lastCompaction) candidateErrors.push(error);
    }
  }
  if (candidateErrors.length > 0) throw candidateErrors[0];
  const poison = exactOne(candidates, "provider-visible poisoned reset boundary");
  const details = poison.message.details ?? {};
  if (details.sessionId !== sessionId || !text(details.workflowPhase, 40)) throw new RalphRecoveryError("Ralph recovery found mismatched session or workflow phase evidence");
  const allowedCommands = { specification: new Set(["reset"]), planning: new Set(["reset", "plan"]), execution: new Set(["reset", "execute", "execute-round"]), blocked: new Set(["reset", "blocked-pass"]) };
  if (!allowedCommands[details.workflowPhase]?.has(poison.command)) throw new RalphRecoveryError("Ralph recovery found mismatched command and workflow phase");
  const allowedModes = {
    specification: { reset: new Set(["specification-new", "specification-reset-existing"]) },
    planning: { reset: new Set(["planning-reset-new", "planning-reset-existing", "blocked-restored"]), plan: new Set(["planning-new", "planning-existing"]) },
    execution: { reset: new Set(["execution-reset-running", "execution-reset-paused"]), execute: new Set(["execution-start", "execution-resume"]), "execute-round": new Set(["execution-continue"]) },
    blocked: { reset: new Set(["blocked-reset", "blocked-restored"]), "blocked-pass": new Set(["blocked-start", "blocked-restored"]) },
  };
  if (!allowedModes[details.workflowPhase]?.[poison.command]?.has(details.invocationMode)) throw new RalphRecoveryError("Ralph recovery found mismatched invocation mode");
  if ((details.workflowPhase === "blocked" || details.workflowPhase === "planning" && details.invocationMode === "blocked-restored") && !text(details.provenanceId)) {
    throw new RalphRecoveryError("Ralph recovery found missing blocked provenance identity");
  }
  if (details.workflowPhase !== "execution" && (details.lifecycleId != null || details.cycle != null)) throw new RalphRecoveryError("Ralph recovery found unexpected lifecycle identity outside execution");
  let root = poison;
  if (!text(details.invocationMode, 80)) throw new RalphRecoveryError("Ralph recovery found missing invocation-mode evidence");
  if (details.workflowPhase === "execution") {
    if (!text(details.lifecycleId) || !Number.isInteger(details.cycle) || details.cycle < 1) throw new RalphRecoveryError("Ralph recovery found incomplete execution identity");
    const poisonMessageIndex = branch.findIndex((entry) => entry.id === poison.message.id);
    const matchingExecution = branch.filter((entry, index) => index > poisonMessageIndex && entry?.type === "custom" && entry.customType === EXECUTION_STATE_ENTRY_TYPE &&
      entry.data?.source === "prime-ralph" && entry.data?.protocolVersion === 1 && entry.data?.phase === "execution" && entry.data?.sessionId === sessionId && entry.data?.lifecycleId === details.lifecycleId && entry.data?.cycle === details.cycle);
    if (matchingExecution.length === 0) throw new RalphRecoveryError("Ralph recovery found no matching execution lifecycle state after the hidden boundary");
    const roots = branch.filter((entry) => entry?.type === "custom_message" && entry.customType === RESET_MESSAGE_TYPE &&
      entry.details?.source === "prime-ralph" && entry.details?.protocolVersion === poison.message.details?.protocolVersion && entry.details?.command === "execute" &&
      entry.details?.workflowPhase === "execution" && entry.details?.invocationMode === "execution-start" && entry.details?.sessionId === sessionId && entry.details?.lifecycleId === details.lifecycleId && entry.details?.cycle === 1 &&
      branch.findIndex((candidate) => candidate.id === entry.id) <= poisonMessageIndex);
    const rootMessage = exactOne(roots, "initial execute boundary");
    root = requestBundle(branch, entriesById, rootMessage.details.requestId, { poisoned: rootMessage.details.requestId === poison.requestId ? true : "historical" });
    if (root.message.id !== rootMessage.id) throw new RalphRecoveryError("Ralph recovery found mismatched execution-root evidence");
  }
  return Object.freeze({
    requestId: poison.requestId, rootRequestId: root.requestId, command: poison.command, workflowPhase: details.workflowPhase,
    lifecycleId: details.lifecycleId ?? null, cycle: details.cycle ?? null, poisonedMarkerId: poison.marker.id, rootMarkerId: root.marker.id,
    anchorId: root.anchor.id,
  });
}

function recoveryRecords(branch, sessionId) {
  return branch.filter((entry) => entry?.type === "custom" && entry.customType === RECOVERY_STATE_TYPE &&
    entry.data?.source === "prime-ralph" && entry.data?.protocolVersion === RECOVERY_PROTOCOL_VERSION && entry.data?.sessionId === sessionId);
}

function validRecoveryRecord(data) {
  return data && text(data.recoveryId) && text(data.sessionId) && text(data.requestId) &&
    text(data.rootRequestId) && data.status === RECOVERY_STATUS && data.outcome === "workflow-state-pending" && text(data.command, 80) && text(data.workflowPhase, 40) && text(data.poisonedMarkerId) &&
    text(data.rootMarkerId) && text(data.priorLeafId) && text(data.anchorId) &&
    (data.lifecycleId == null || text(data.lifecycleId)) && (data.cycle == null || (Number.isInteger(data.cycle) && data.cycle >= 1));
}

function isExactRecoveredWorkflowState(entry, recovery, sessionId) {
  const state = entry?.data, required = state?.recoveryRequired;
  return entry?.type === "custom" && entry.customType === EXECUTION_STATE_ENTRY_TYPE &&
    state?.source === "prime-ralph" && state?.protocolVersion === 1 && state?.sessionId === sessionId && state?.phase === "planning" && state?.status === "inactive" &&
    state?.lifecycleId == null && state?.cycle === 0 && state?.driverGoalId == null && state?.pendingDecision == null && state?.pendingRound == null &&
    state?.admittedContinuation == null && state?.wait == null && state?.resetRequested === false &&
    required?.protocolVersion === RECOVERY_PROTOCOL_VERSION && required?.recoveryId === recovery.recoveryId &&
    required?.requestId === recovery.requestId && required?.rootRequestId === recovery.rootRequestId &&
    required?.anchorId === recovery.anchorId && required?.priorLeafId === recovery.priorLeafId;
}

export function planRalphRecovery({ branch, entries, sessionId, leafId }) {
  if (!Array.isArray(branch) || !Array.isArray(entries) || !text(sessionId) || !text(leafId) || branch.at(-1)?.id !== leafId) {
    throw new RalphRecoveryError("Ralph recovery requires an unchanged exact current leaf");
  }
  const reconstructed = branchForLeaf(entries, leafId);
  if (reconstructed.length !== branch.length || !reconstructed.every((entry, index) => entry.id === branch[index]?.id)) {
    throw new RalphRecoveryError("Ralph recovery current branch does not match the durable ancestor chain");
  }
  const records = recoveryRecords(branch, sessionId);
  if (new Set(records.map((entry) => entry.data?.recoveryId)).size !== records.length) throw new RalphRecoveryError("Ralph recovery found duplicate recovery provenance");
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const entry = records[recordIndex], latest = entry.data;
    if (!validRecoveryRecord(latest)) throw new RalphRecoveryError("Ralph recovery found malformed recovery provenance");
    const candidateBranch = branchForLeaf(entries, latest.priorLeafId);
    const candidate = findPoisonedRecoveryCandidate(candidateBranch, entries, sessionId);
    if (!["requestId", "rootRequestId", "command", "workflowPhase", "lifecycleId", "cycle", "poisonedMarkerId", "rootMarkerId", "anchorId"].every((field) => candidate[field] === latest[field])) {
      throw new RalphRecoveryError("Ralph recovery provenance no longer matches the abandoned branch");
    }
    const entryIndex = branch.findIndex((candidateEntry) => candidateEntry.id === entry.id);
    if (entryIndex < 1 || branch[entryIndex - 1]?.id !== latest.anchorId) throw new RalphRecoveryError("Ralph recovery provenance is not attached to its exact anchor");
    const following = branch[entryIndex + 1];
    if (isExactRecoveredWorkflowState(following, latest, sessionId)) {
      if (entryIndex + 1 === branch.length - 1) return Object.freeze({ kind: "completed", record: latest, candidate });
      continue;
    }
    if (entryIndex === branch.length - 1 && recordIndex === records.length - 1) return Object.freeze({ kind: "append-inactive", record: latest, candidate });
    throw new RalphRecoveryError("Ralph recovery found an unexpected post-navigation workflow state");
  }
  try {
    const candidate = findPoisonedRecoveryCandidate(branch, entries, sessionId);
    return Object.freeze({ kind: "navigate", candidate, priorLeafId: leafId });
  } catch (currentError) {
    const children = new Map();
    for (const entry of entries) if (entry?.parentId) children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
    const descendantLeaves = entries.filter((entry) => !children.has(entry.id)).filter((entry) => {
      try { return branchForLeaf(entries, entry.id).some((ancestor) => ancestor.id === leafId); } catch { return false; }
    });
    const inferred = [];
    for (const leaf of descendantLeaves) {
      try {
        const candidateBranch = branchForLeaf(entries, leaf.id);
        const candidate = findPoisonedRecoveryCandidate(candidateBranch, entries, sessionId);
        if (candidate.anchorId === leafId) inferred.push({ candidate, priorLeafId: leaf.id });
      } catch {}
    }
    if (inferred.length !== 1) throw currentError;
    return Object.freeze({ kind: "append-provenance", ...inferred[0] });
  }
}

export function recoveryRecord(candidate, { recoveryId, sessionId, priorLeafId }) {
  if (!candidate || !text(recoveryId) || !text(sessionId) || !text(priorLeafId)) throw new TypeError("valid Ralph recovery provenance is required");
  return Object.freeze({
    source: "prime-ralph", protocolVersion: RECOVERY_PROTOCOL_VERSION, recoveryId, status: RECOVERY_STATUS, outcome: "workflow-state-pending", sessionId,
    requestId: candidate.requestId, rootRequestId: candidate.rootRequestId, command: candidate.command, workflowPhase: candidate.workflowPhase,
    lifecycleId: candidate.lifecycleId, cycle: candidate.cycle, poisonedMarkerId: candidate.poisonedMarkerId, rootMarkerId: candidate.rootMarkerId,
    priorLeafId, anchorId: candidate.anchorId,
  });
}
