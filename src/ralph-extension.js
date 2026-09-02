import { isFinalNormalAssistantTurn } from "./cycle-boundary-poc.js";

export function createRalphExtension({ enabled = false, goalActive = () => true, bootstrap = "Read the durable Ralph specification and execution plan; select one task." } = {}) {
  return (pi) => {
    if (!enabled) return;
    let compactRequested = false;
    pi.on("turn_end", (event, ctx) => {
      if (!compactRequested && isFinalNormalAssistantTurn(event) && goalActive()) { compactRequested = true; ctx.compact({ customInstructions: bootstrap }); }
    });
    pi.on("session_before_compact", (event) => ({ compaction: { summary: `RALPH_BOOTSTRAP:${bootstrap}`, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { source: "prime-ralph" } } }));
    pi.on("session_compact", () => {
      if (!goalActive()) return;
      setTimeout(() => pi.sendMessage({ customType: "goal_context", content: "<goal_context>continue</goal_context>", display: true, details: { source: "prime-ralph" } }, { triggerTurn: true, deliverAs: "followUp" }), 0);
    });
  };
}
