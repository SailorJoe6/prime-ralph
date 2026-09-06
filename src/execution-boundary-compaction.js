export const EXECUTION_COMPACTION_MARKER_TYPE = "prime_ralph_execution_compaction_marker";
export const EXECUTION_COMPACTION_INSTRUCTION_PREFIX = "prime-ralph-execution-boundary:v1:";
export const EXECUTION_COMPACTION_PROTOCOL_VERSION = 1;

const CORRELATION_FIELDS = Object.freeze([
  "requestId", "sessionId", "lifecycleId", "cycle", "goalId", "continuationsUsed", "boundaryIdentity",
]);

function validBoundedString(value, maximum = 200) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validCorrelation(value, { requireMarkerId = false } = {}) {
  return Boolean(value && (!requireMarkerId || validBoundedString(value.markerId)) &&
    validBoundedString(value.requestId) && validBoundedString(value.sessionId) &&
    validBoundedString(value.lifecycleId) && Number.isInteger(value.cycle) && value.cycle >= 1 &&
    validBoundedString(value.goalId) && Number.isInteger(value.continuationsUsed) && value.continuationsUsed >= 0 &&
    validBoundedString(value.boundaryIdentity) && value.boundaryIdentity === `${value.goalId}:${value.continuationsUsed}`);
}

function exactCorrelation(value, expected) {
  return CORRELATION_FIELDS.every((field) => value[field] === expected[field]);
}

export function executionCompactionInstructions(requestId) {
  if (!validBoundedString(requestId)) throw new TypeError("execution compaction requestId must contain 1 to 200 characters");
  return `${EXECUTION_COMPACTION_INSTRUCTION_PREFIX}${requestId}`;
}

export function executionCompactionRequestId(customInstructions) {
  if (typeof customInstructions !== "string" || !customInstructions.startsWith(EXECUTION_COMPACTION_INSTRUCTION_PREFIX)) return undefined;
  const requestId = customInstructions.slice(EXECUTION_COMPACTION_INSTRUCTION_PREFIX.length);
  return validBoundedString(requestId) ? requestId : undefined;
}

function markerNamespaceCandidate(entry, requestId) {
  return entry?.type === "custom" && entry.customType === EXECUTION_COMPACTION_MARKER_TYPE &&
    entry.data?.source === "prime-ralph" && entry.data?.protocolVersion === EXECUTION_COMPACTION_PROTOCOL_VERSION &&
    entry.data?.requestId === requestId;
}

export function isExecutionCompactionMarker(entry, correlation) {
  const data = entry?.data;
  return validCorrelation(correlation) && validBoundedString(entry?.id) && markerNamespaceCandidate(entry, correlation.requestId) &&
    validCorrelation(data) && (correlation.markerId === undefined || entry.id === correlation.markerId) &&
    exactCorrelation(data, correlation);
}

export function latestExecutionCompactionMarker(entries, correlation) {
  if (!Array.isArray(entries) || !validCorrelation(correlation)) return undefined;
  const candidates = entries.filter((entry) => markerNamespaceCandidate(entry, correlation.requestId));
  return candidates.length === 1 && isExecutionCompactionMarker(candidates[0], correlation) ? candidates[0] : undefined;
}

function compactionNamespaceCandidate(entry, requestId) {
  return entry?.type === "compaction" && entry.customInstructions === executionCompactionInstructions(requestId);
}

function exactCompaction(entry, markerId, requestId) {
  return validBoundedString(entry?.id) && compactionNamespaceCandidate(entry, requestId) &&
    entry.summary === "" && entry.firstKeptEntryId === markerId;
}

function boundaryNamespaceCandidate(entry, requestId) {
  return entry?.type === "custom_message" && entry.customType === "prime_ralph_execution_skill" &&
    entry.details?.source === "prime-ralph" && entry.details?.protocolVersion === 1 &&
    entry.details?.automaticCompactionRequestId === requestId;
}

function exactBoundary(entry, correlation) {
  const details = entry?.details;
  return validBoundedString(entry?.id) && boundaryNamespaceCandidate(entry, correlation.requestId) &&
    details.sessionId === correlation.sessionId && details.lifecycleId === correlation.lifecycleId &&
    details.cycle === correlation.cycle && details.goalId === correlation.goalId &&
    details.continuationsUsed === correlation.continuationsUsed && details.boundaryIdentity === correlation.boundaryIdentity;
}

export function inspectExecutionCompactionRecovery(entries, correlation) {
  if (!Array.isArray(entries) || !validCorrelation(correlation, { requireMarkerId: true })) return Object.freeze({ state: "invalid" });
  const markerCandidates = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    markerNamespaceCandidate(entry, correlation.requestId));
  const compactionCandidates = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    compactionNamespaceCandidate(entry, correlation.requestId));
  const boundaryCandidates = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    boundaryNamespaceCandidate(entry, correlation.requestId));
  if (markerCandidates.length === 0) return Object.freeze({ state: compactionCandidates.length || boundaryCandidates.length ? "ambiguous" : "absent" });
  if (markerCandidates.length !== 1 || !isExecutionCompactionMarker(markerCandidates[0].entry, correlation)) return Object.freeze({ state: "ambiguous" });
  if (compactionCandidates.length === 0) return boundaryCandidates.length
    ? Object.freeze({ state: "ambiguous" })
    : Object.freeze({ state: "marker-only", marker: markerCandidates[0].entry });
  if (compactionCandidates.length !== 1 || compactionCandidates[0].index <= markerCandidates[0].index ||
      !exactCompaction(compactionCandidates[0].entry, correlation.markerId, correlation.requestId)) {
    return Object.freeze({ state: "ambiguous" });
  }

  if (boundaryCandidates.length === 0) return Object.freeze({ state: "compacted", marker: markerCandidates[0].entry, compaction: compactionCandidates[0].entry });
  if (boundaryCandidates.length !== 1 || boundaryCandidates[0].index <= compactionCandidates[0].index ||
      !exactBoundary(boundaryCandidates[0].entry, correlation)) return Object.freeze({ state: "ambiguous" });
  return Object.freeze({ state: "resumed", marker: markerCandidates[0].entry, compaction: compactionCandidates[0].entry, boundary: boundaryCandidates[0].entry });
}

export function hasExecutionCompaction(entries, correlation) {
  return ["compacted", "resumed"].includes(inspectExecutionCompactionRecovery(entries, correlation).state);
}

export function hasExecutionBoundary(entries, correlation) {
  return inspectExecutionCompactionRecovery(entries, correlation).state === "resumed";
}

export function isExecutionCompactionSummary(message, requestId) {
  return validBoundedString(requestId) && message?.role === "compactionSummary" && message.summary === "" &&
    executionCompactionRequestId(message.customInstructions) === requestId;
}
