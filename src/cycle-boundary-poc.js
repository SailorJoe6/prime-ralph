/** Research-only cycle-boundary predicate. Not production orchestration. */
export function hasToolCall(message) {
  return Array.isArray(message?.content) && message.content.some((part) => part?.type === "toolCall");
}

export function isFinalNormalAssistantTurn(event) {
  if (!event || event.type !== "turn_end") return false;
  const message = event.message;
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  if (hasToolCall(message)) return false;
  if (Array.isArray(event.toolResults) && event.toolResults.length > 0) return false;
  return true;
}

export function shouldRequestGoalCycleCompaction(event, state) {
  return isFinalNormalAssistantTurn(event) && state?.status === "active" && state?.objectivePresent === true;
}
