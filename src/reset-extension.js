import { randomUUID } from "node:crypto";
import { formatPrepareInjection, loadPrepareSkill } from "./reset-skill.js";
import { formatSpecificationInjection, inspectActiveSpecification, loadSpecItOutSkill } from "./specification.js";
import {
  hasResetBoundary,
  hasResetCompaction,
  latestResetState,
  projectResetContext,
  resetCompactionInstructions,
  RESET_MARKER_TYPE,
  RESET_MESSAGE_TYPE,
  RESET_PROTOCOL_VERSION,
  RESET_STATE_TYPE,
} from "./reset-context.js";

const TERMINAL_STATES = new Set(["completed", "interrupted", "failed", "recovered"]);
const SHORT_COMPACTION_REASONS = ["Session is too short to compact", "Already compacted"];

export function createResetExtension({
  loadPrepare = loadPrepareSkill,
  loadSpecItOut = loadSpecItOutSkill,
  inspectSpecification = inspectActiveSpecification,
  createRequestId = randomUUID,
} = {}) {
  return function resetExtension(pi) {
    let pending;
    let activeRequestId;

    const appendState = (status, requestId, details = {}) => pi.appendEntry(RESET_STATE_TYPE, {
      source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status, ...details,
    });

    const clearPending = () => {
      pending = undefined;
      activeRequestId = undefined;
    };

    const recover = (ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const state = latestResetState(entries);
      if (!state || TERMINAL_STATES.has(state.status)) return;
      const boundaryExists = hasResetBoundary(entries, state.requestId);
      const compactionExists = hasResetCompaction(entries, state.requestId);
      appendState("recovered", state.requestId, { boundaryExists, compactionExists });
      clearPending();
      ctx.ui.notify(boundaryExists
        ? "Recovered the completed Ralph reset boundary without replaying prepare."
        : compactionExists
          ? "Ralph reset compacted before prepare was admitted; run /reset again."
          : "An interrupted Ralph reset was cancelled safely; run /reset again.",
      boundaryExists ? "info" : "warning");
    };

    pi.registerCommand("reset", {
      description: "Reset model-visible context in this session and run the project prepare skill",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /reset");
        if (pending) {
          ctx.ui.notify("A Ralph reset is already pending.", "warning");
          return;
        }

        await ctx.waitForIdle();
        if (pending) {
          ctx.ui.notify("A Ralph reset is already pending.", "warning");
          return;
        }

        // Validate phase facts and every required skill before creating a marker or changing provider-visible context.
        const specification = inspectSpecification({ cwd: ctx.cwd });
        if (!new Set(["absent", "existing"]).has(specification.state)) throw new TypeError(`unsupported specification state: ${specification.state}`);
        const skill = loadPrepare({ cwd: ctx.cwd });
        const specificationSkill = specification.state === "existing" ? loadSpecItOut({ cwd: ctx.cwd }) : undefined;
        const injection = specificationSkill
          ? `${formatPrepareInjection(skill)}
${formatSpecificationInjection(specificationSkill, "specification-reset-existing")}`
          : formatPrepareInjection(skill);
        const requestId = createRequestId();
        pi.appendEntry(RESET_MARKER_TYPE, {
          source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId,
        });
        const marker = ctx.sessionManager.getBranch().at(-1);
        if (marker?.type !== "custom" || marker.customType !== RESET_MARKER_TYPE ||
            marker.data?.requestId !== requestId || !marker.id) {
          throw new Error("Ralph reset marker was not durably observable");
        }

        const customInstructions = resetCompactionInstructions(requestId);
        pending = { requestId, markerId: marker.id, customInstructions, injection };
        appendState("compacting", requestId, { markerId: marker.id });

        const injectPrepare = (mode) => {
          const prepareMessage = {
            role: "custom",
            customType: RESET_MESSAGE_TYPE,
            content: pending?.injection ?? injection,
            display: false,
            details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, mode },
            timestamp: Date.now(),
          };
          if (pending?.requestId === requestId) {
            pending.stage = "prepare_pending";
            pending.cleanNextContext = true;
            pending.prepareMessage = prepareMessage;
          }
          appendState("prepare_pending", requestId, { mode });
          pi.sendMessage(prepareMessage, { triggerTurn: true, deliverAs: "followUp" });
          ctx.ui.notify("Ralph reset started.", "info");
        };

        ctx.compact({
          customInstructions,
          onComplete: (result) => {
            if (!pending || pending.requestId !== requestId) return;
            if (result.summary !== "" || result.firstKeptEntryId !== marker.id) {
              appendState("failed", requestId, { reason: "unexpected_compaction_result" });
              clearPending();
              ctx.ui.notify("Ralph reset compaction returned an unexpected boundary; run /reset again.", "error");
              return;
            }
            injectPrepare("compaction");
          },
          onError: (error) => {
            if (!pending || pending.requestId !== requestId) return;
            const reason = String(error?.message ?? error);
            if (SHORT_COMPACTION_REASONS.some((expected) => reason.includes(expected))) {
              injectPrepare("projection-fallback");
              return;
            }
            appendState("failed", requestId, { reason: "compaction_failed" });
            clearPending();
            ctx.ui.notify("Ralph reset failed before prepare was delivered; run /reset again.", "error");
          },
        });
      },
    });

    pi.on("session_start", (_event, ctx) => recover(ctx));
    pi.on("session_before_compact", (event) => {
      if (!pending || event.customInstructions !== pending.customInstructions) return;
      const marker = event.branchEntries.find((entry) => entry.id === pending.markerId);
      if (!marker || marker.type !== "custom" || marker.customType !== RESET_MARKER_TYPE ||
          marker.data?.requestId !== pending.requestId) return { cancel: true };
      return {
        compaction: {
          summary: "",
          firstKeptEntryId: marker.id,
          tokensBefore: event.preparation.tokensBefore,
          details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: pending.requestId },
        },
      };
    });
    pi.on("context", (event) => {
      if (pending?.stage === "prepare_pending" && pending.cleanNextContext) {
        pending.cleanNextContext = false;
        return { messages: pending.prepareMessage ? [pending.prepareMessage] : [] };
      }
      return { messages: projectResetContext(event.messages) };
    });
    pi.on("message_start", (event) => {
      if (!pending || event.message?.customType !== RESET_MESSAGE_TYPE) return;
      if (event.message.details?.requestId === pending.requestId) activeRequestId = pending.requestId;
    });
    pi.on("agent_end", (event) => {
      if (!pending || activeRequestId !== pending.requestId) return;
      const finalAssistant = [...(event.messages ?? [])].reverse().find((message) => message?.role === "assistant");
      if (finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted") {
        appendState("failed", pending.requestId, { reason: finalAssistant.stopReason === "aborted" ? "provider_aborted" : "provider_error", boundaryExists: true });
      } else {
        appendState("completed", pending.requestId, { mode: "settled" });
      }
      clearPending();
    });
    pi.on("session_shutdown", (event) => {
      if (!pending) return;
      appendState("interrupted", pending.requestId, { reason: event.reason });
      clearPending();
    });
  };
}

export default createResetExtension();
