export function hasToolCall(message) {
  return Array.isArray(message?.content) && message.content.some((part) => part?.type === "toolCall");
}

export function isFinalNormalAssistantTurn(event) {
  if (!event || event.type !== "turn_end") return false;
  const message = event.message;
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  if (hasToolCall(message)) return false;
  return true;
}
