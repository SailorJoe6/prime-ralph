export const RESET_MESSAGE_TYPE = "prime_ralph_reset_prepare";
export const RESET_STATE_TYPE = "prime_ralph_reset_state";
export const RESET_MARKER_TYPE = "prime_ralph_reset_marker";
export const RESET_PROTOCOL_VERSION = 2;
export const RESET_COMPACTION_INSTRUCTION_PREFIX = "prime-ralph-reset:v2:";

export function resetCompactionInstructions(requestId) {
  return `${RESET_COMPACTION_INSTRUCTION_PREFIX}${requestId}`;
}

export function isResetPrepareMessage(message) {
  return message?.role === "custom" && message.customType === RESET_MESSAGE_TYPE &&
    message.details?.source === "prime-ralph" && message.details?.protocolVersion === RESET_PROTOCOL_VERSION &&
    typeof message.details?.requestId === "string";
}

export function isResetCompactionSummary(message) {
  return message?.role === "compactionSummary" && message.summary === "" &&
    typeof message.customInstructions === "string" &&
    message.customInstructions.startsWith(RESET_COMPACTION_INSTRUCTION_PREFIX);
}

/** Remove Ralph's fixed empty compaction wrapper and enforce the newest persisted prepare boundary exactly. */
export function projectResetContext(messages) {
  if (!Array.isArray(messages)) return [];
  let projected = messages;
  if (isResetCompactionSummary(projected[0])) projected = projected.slice(1);
  let boundary = -1;
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    if (isResetPrepareMessage(projected[index])) {
      boundary = index;
      break;
    }
  }
  return boundary < 0 ? projected : projected.slice(boundary);
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

export function hasResetBoundary(entries, requestId) {
  return Array.isArray(entries) && entries.some((entry) => entry?.type === "custom_message" &&
    entry.customType === RESET_MESSAGE_TYPE && entry.details?.source === "prime-ralph" &&
    entry.details?.protocolVersion === RESET_PROTOCOL_VERSION && entry.details?.requestId === requestId);
}

export function hasResetCompaction(entries, requestId) {
  return Array.isArray(entries) && entries.some((entry) => entry?.type === "compaction" && entry.summary === "" &&
    entry.customInstructions === resetCompactionInstructions(requestId));
}
