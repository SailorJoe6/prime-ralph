export const RESET_MESSAGE_TYPE = "prime_ralph_reset_prepare";
export const RESET_STATE_TYPE = "prime_ralph_reset_state";
export const RESET_MARKER_TYPE = "prime_ralph_reset_marker";
export const RESET_PROTOCOL_VERSION = 2;
export const RESET_COMPACTION_INSTRUCTION_PREFIX = "prime-ralph-reset:v2:";

export function resetCompactionInstructions(requestId) {
  return `${RESET_COMPACTION_INSTRUCTION_PREFIX}${requestId}`;
}

export function latestResetState(entries) {
  if (!Array.isArray(entries)) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === RESET_STATE_TYPE &&
        entry.data?.source === "prime-ralph" && entry.data?.protocolVersion === RESET_PROTOCOL_VERSION) return entry.data;
  }
  return undefined;
}

export function latestResetStateForRequest(entries, requestId) {
  if (!Array.isArray(entries) || typeof requestId !== "string" || !requestId) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === RESET_STATE_TYPE &&
        entry.data?.source === "prime-ralph" && entry.data?.protocolVersion === RESET_PROTOCOL_VERSION &&
        entry.data?.requestId === requestId) return entry.data;
  }
  return undefined;
}

export function hasResetBoundary(entries, requestId) {
  return Array.isArray(entries) && entries.some((entry) => entry?.type === "custom_message" &&
    entry.customType === RESET_MESSAGE_TYPE && entry.details?.source === "prime-ralph" &&
    entry.details?.protocolVersion === RESET_PROTOCOL_VERSION && entry.details?.requestId === requestId);
}

export function hasResetCompaction(entries, requestId) {
  return Array.isArray(entries) && entries.some((entry) => entry?.type === "compaction" && entry.summary === "" &&
    entry.customInstructions === resetCompactionInstructions(requestId));
}
