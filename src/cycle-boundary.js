export function hasToolCall(message) {
  return Array.isArray(message?.content) && message.content.some((part) => part?.type === "toolCall");
}

function finalToolCallIds(event, { requireResults = false } = {}) {
  if (!Array.isArray(event?.messages)) return null;
  const assistantIndex = event.messages.findLastIndex((candidate) => candidate?.role === "assistant");
  const message = event.messages[assistantIndex];
  if (assistantIndex < 0 || message?.stopReason !== "toolUse" || !Array.isArray(message.content)) return null;
  const calls = message.content.filter((part) => part?.type === "toolCall");
  const ids = calls.map((part) => part?.id);
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) return null;
  if (!requireResults) return ids;
  const results = event.messages.slice(assistantIndex + 1).filter((candidate) => candidate?.role === "toolResult");
  const resultIds = results.map((result) => result?.toolCallId);
  if (results.length !== ids.length || resultIds.some((id) => typeof id !== "string" || !id) ||
      new Set(resultIds).size !== resultIds.length || results.some((result) => result?.isError !== false) ||
      ids.some((id) => !resultIds.includes(id))) return null;
  return ids;
}

function liveAbortSignal(value) {
  return value != null && typeof value === "object" && typeof value.aborted === "boolean" && typeof value.addEventListener === "function";
}

export function createQueuedToolHandoffTracker() {
  let epoch = 0;
  let currentEpoch;
  let request;
  const verdicts = new WeakMap();
  const finishedEvents = new WeakSet();

  const invalidate = () => { currentEpoch = undefined; request = undefined; };
  const beginRun = () => {
    currentEpoch = ++epoch;
    request = undefined;
    return currentEpoch;
  };
  const record = (event, ctx, { requestKey, admitted } = {}) => {
    try {
      if (!Number.isInteger(currentEpoch) || admitted !== true || typeof requestKey !== "string" || !requestKey ||
          event?.type !== "tool_result" || typeof event.toolCallId !== "string" || !event.toolCallId) {
        invalidate();
        return false;
      }
      const signal = ctx?.signal;
      if (!liveAbortSignal(signal) || signal.aborted !== false) {
        invalidate();
        return false;
      }
      if (!request) request = { key: requestKey, epoch: currentEpoch, signal, results: new Map() };
      if (request.key !== requestKey || request.epoch !== currentEpoch || request.signal !== signal) {
        invalidate();
        return false;
      }
      const duplicate = request.results.has(event.toolCallId);
      if (duplicate || event.isError !== false) {
        invalidate();
        return false;
      }
      request.results.set(event.toolCallId, { success: true });
      return true;
    } catch {
      invalidate();
      return false;
    }
  };

  const hasWitness = () => Number.isInteger(currentEpoch) && request?.epoch === currentEpoch && request.results.size > 0;

  const classify = (event, ctx, { requestKey, admitted } = {}) => {
    if (event == null || typeof event !== "object" || finishedEvents.has(event)) return false;
    if (verdicts.has(event)) return verdicts.get(event);
    let accepted = false;
    try {
      const ids = finalToolCallIds(event, { requireResults: true });
      const pending = ctx?.hasPendingMessages?.() === true;
      const dynamicSignal = ctx?.signal;
      const exactRequest = admitted === true && typeof requestKey === "string" && requestKey && request?.key === requestKey &&
        Number.isInteger(currentEpoch) && request.epoch === currentEpoch;
      const exactResults = exactRequest && ids != null && ids.every((id) => request.results.get(id)?.success === true);
      const currentSignalMatches = dynamicSignal === undefined || dynamicSignal === request?.signal;
      accepted = Boolean(pending && exactResults && liveAbortSignal(request?.signal) && request.signal.aborted === false && currentSignalMatches);
    } catch {
      accepted = false;
    }
    verdicts.set(event, accepted);
    return accepted;
  };

  const finish = (event, { preserveRun = false } = {}) => {
    if (event != null && typeof event === "object") {
      verdicts.delete(event);
      finishedEvents.add(event);
    }
    if (!preserveRun) invalidate();
  };

  return Object.freeze({ beginRun, record, hasWitness, classify, finish, invalidate });
}

export function isFinalNormalAssistantTurn(event) {
  if (!event || event.type !== "turn_end") return false;
  const message = event.message;
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  if (hasToolCall(message)) return false;
  return true;
}

export function isQueuedToolHandoff(event, ctx) {
  if (!Array.isArray(event?.messages) || ctx?.signal?.aborted !== false || ctx?.hasPendingMessages?.() !== true) return false;
  return finalToolCallIds(event) != null;
}
