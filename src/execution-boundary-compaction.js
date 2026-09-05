export const EXECUTION_COMPACTION_MARKER_TYPE = "prime_ralph_execution_compaction_marker";
export const EXECUTION_COMPACTION_INSTRUCTION_PREFIX = "prime-ralph-execution-boundary:v1:";
export const EXECUTION_COMPACTION_PROTOCOL_VERSION = 1;

export function executionCompactionInstructions(requestId) {
  if (typeof requestId !== "string" || !requestId) throw new TypeError("execution compaction requestId is required");
  return `${EXECUTION_COMPACTION_INSTRUCTION_PREFIX}${requestId}`;
}

export function executionCompactionRequestId(customInstructions) {
  if (typeof customInstructions !== "string" || !customInstructions.startsWith(EXECUTION_COMPACTION_INSTRUCTION_PREFIX)) return undefined;
  const requestId = customInstructions.slice(EXECUTION_COMPACTION_INSTRUCTION_PREFIX.length);
  return requestId || undefined;
}

export function isExecutionCompactionMarker(entry, correlation = {}) {
  const data = entry?.data;
  if (entry?.type !== "custom" || entry.customType !== EXECUTION_COMPACTION_MARKER_TYPE ||
      data?.source !== "prime-ralph" || data?.protocolVersion !== EXECUTION_COMPACTION_PROTOCOL_VERSION) return false;
  for (const [key, value] of Object.entries(correlation)) {
    if (value !== undefined && data?.[key] !== value) return false;
  }
  return typeof data.requestId === "string" && Boolean(data.requestId) && typeof entry.id === "string" && Boolean(entry.id);
}

export function latestExecutionCompactionMarker(entries, correlation = {}) {
  if (!Array.isArray(entries)) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isExecutionCompactionMarker(entries[index], correlation)) return entries[index];
  }
  return undefined;
}

export function hasExecutionCompaction(entries, correlation = {}) {
  const { markerId, ...markerCorrelation } = correlation;
  const marker = latestExecutionCompactionMarker(entries, markerCorrelation);
  if (!Array.isArray(entries) || marker?.id !== markerId) return false;
  const { requestId } = correlation;
  return entries.some((entry) => entry?.type === "compaction" && entry.summary === "" &&
    entry.firstKeptEntryId === markerId && entry.customInstructions === executionCompactionInstructions(requestId));
}

export function isExecutionCompactionSummary(message, requestId) {
  return message?.role === "compactionSummary" && message.summary === "" &&
    message.customInstructions === executionCompactionInstructions(requestId);
}

export function hasExecutionBoundary(entries, correlation = {}) {
  const { requestId, boundaryIdentity, lifecycleId, cycle, goalId, continuationsUsed } = correlation;
  return Array.isArray(entries) && entries.some((entry) => entry?.type === "custom_message" &&
    entry.customType === "prime_ralph_execution_skill" && entry.details?.source === "prime-ralph" && entry.details?.protocolVersion === 1 &&
    entry.details?.automaticCompactionRequestId === requestId && entry.details?.boundaryIdentity === boundaryIdentity &&
    entry.details?.lifecycleId === lifecycleId && entry.details?.cycle === cycle && entry.details?.goalId === goalId &&
    entry.details?.continuationsUsed === continuationsUsed);
}
