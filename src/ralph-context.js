/** Context projection for the research POC; production policy is not enabled yet. */
export function projectRalphBootstrapContext(messages) {
  if (!Array.isArray(messages)) return [];
  let summaryIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "compactionSummary") { summaryIndex = i; break; }
  }
  if (summaryIndex < 0) return messages;
  return messages.slice(summaryIndex).filter((message, index) => {
    if (index === 0 && message.role === "compactionSummary") return true;
    if (message.role === "custom" && message.customType === "goal_context") return true;
    return false;
  });
}
