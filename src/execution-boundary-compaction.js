export const EXECUTION_COMPACTION_INSTRUCTION_PREFIX = "prime-ralph-execution-boundary:v1:";

export function executionCompactionInstructions(requestId) {
  if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw new TypeError("execution compaction requestId must contain 1 to 200 characters");
  return `${EXECUTION_COMPACTION_INSTRUCTION_PREFIX}${requestId}`;
}

export function executionCompactionRequestId(customInstructions) {
  if (typeof customInstructions !== "string" || !customInstructions.startsWith(EXECUTION_COMPACTION_INSTRUCTION_PREFIX)) return undefined;
  const requestId = customInstructions.slice(EXECUTION_COMPACTION_INSTRUCTION_PREFIX.length);
  return requestId && requestId.length <= 200 ? requestId : undefined;
}

export function isExecutionCompactionSummary(message, requestId) {
  return message?.role === "compactionSummary" && message.summary === "" &&
    executionCompactionRequestId(message.customInstructions) === requestId;
}
