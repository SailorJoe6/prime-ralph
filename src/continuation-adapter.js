/**
 * Schedules the explicit post-compaction continuation outside the compaction
 * event callback. The host must call settle() only after compaction has ended.
 */
export function createContinuationAdapter({ sendMessage, schedule = (fn) => queueMicrotask(fn), onError = () => {} } = {}) {
  if (typeof sendMessage !== "function") throw new TypeError("sendMessage is required");
  let settled = false;
  let admitted = false;
  let cancelled = false;
  return {
    settle({ activeGoal = true } = {}) {
      if (!activeGoal || cancelled || admitted) return false;
      settled = true;
      schedule(() => {
        if (!settled || cancelled || admitted) return;
        admitted = true;
        Promise.resolve(sendMessage({ customType: "goal_context", content: "<goal_context>continue</goal_context>", display: true, details: { source: "prime-ralph" } }, { triggerTurn: true, deliverAs: "followUp" })).catch(onError);
      });
      return true;
    },
    cancel() { cancelled = true; settled = false; },
    snapshot() { return { settled, admitted, cancelled }; },
  };
}
