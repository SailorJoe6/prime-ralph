import { isFinalNormalAssistantTurn } from "./cycle-boundary-poc.js";
import { isCompatiblePrimeAgent } from "./diagnostics.js";

export function createRalphExtension({ enabled = false, goalActive = () => true, bootstrap = "Read the durable Ralph specification and execution plan; select one task.", primeAgentVersion = null } = {}) {
  if (primeAgentVersion !== null && !isCompatiblePrimeAgent(primeAgentVersion)) throw new Error("unsupported Prime Agent version");
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
  if (typeof goalActive !== "function") throw new TypeError("goalActive must be a function");
  const fixedBootstrap = String(bootstrap).slice(0, 4000);
  return (pi) => {
    if (!enabled) return;
    let compactRequested = false;
    pi.on("turn_end", (event, ctx) => {
      if (!compactRequested && isFinalNormalAssistantTurn(event) && goalActive()) { compactRequested = true; ctx.compact({ customInstructions: fixedBootstrap }); }
    });
    pi.on("session_before_compact", (event) => ({ compaction: { summary: `RALPH_BOOTSTRAP:${fixedBootstrap}`, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { source: "prime-ralph" } } }));
    pi.on("session_compact", () => {
      if (!goalActive()) return;
      setTimeout(() => pi.sendMessage({ customType: "goal_context", content: "<goal_context>continue</goal_context>", display: true, details: { source: "prime-ralph" } }, { triggerTurn: true, deliverAs: "followUp" }), 0);
    });
  };
}
