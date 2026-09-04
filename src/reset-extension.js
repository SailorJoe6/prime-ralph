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

function defaultResetInjection({ ctx, loadPrepare, loadSpecItOut, inspectSpecification }) {
  const specification = inspectSpecification({ cwd: ctx.cwd });
  if (!new Set(["absent", "existing"]).has(specification.state)) throw new TypeError(`unsupported specification state: ${specification.state}`);
  const prepare = loadPrepare({ cwd: ctx.cwd });
  const specificationSkill = specification.state === "existing" ? loadSpecItOut({ cwd: ctx.cwd }) : undefined;
  return {
    content: specificationSkill
      ? `${formatPrepareInjection(prepare)}
${formatSpecificationInjection(specificationSkill, "specification-reset-existing")}`
      : formatPrepareInjection(prepare),
    details: { workflowPhase: "specification", invocationMode: specification.state === "existing" ? "specification-reset-existing" : "specification-new", sessionId: ctx.sessionManager.getSessionId?.() },
  };
}

export function createResetExtension({
  loadPrepare = loadPrepareSkill,
  loadSpecItOut = loadSpecItOutSkill,
  inspectSpecification = inspectActiveSpecification,
  resolveResetInjection,
  createRequestId = randomUUID,
} = {}) {
  return function resetExtension(pi) {
    let pending;
    let activeRequestId;

    const appendState = (status, requestId, details = {}) => pi.appendEntry(RESET_STATE_TYPE, {
      source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status, ...details,
    });
    const clearPending = () => { pending = undefined; activeRequestId = undefined; };

    const recover = (ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const state = latestResetState(entries);
      if (!state || TERMINAL_STATES.has(state.status)) return;
      const boundaryExists = hasResetBoundary(entries, state.requestId);
      const compactionExists = hasResetCompaction(entries, state.requestId);
      appendState("recovered", state.requestId, { boundaryExists, compactionExists });
      clearPending();
      ctx.ui.notify(boundaryExists
        ? "Recovered the completed Ralph context boundary without replaying its skill prompt."
        : compactionExists
          ? "Ralph context reset compacted before prepare was admitted; retry the command."
          : "An interrupted Ralph context reset was cancelled safely; retry the command.",
      boundaryExists ? "info" : "warning");
    };

    const requestBoundary = async ({ ctx, command = "reset", resolveInjection, onAdmitted } = {}) => {
      if (!ctx) throw new TypeError("context is required");
      if (pending) { ctx.ui.notify("A Ralph context reset is already pending.", "warning"); return false; }
      await ctx.waitForIdle();
      if (pending) { ctx.ui.notify("A Ralph context reset is already pending.", "warning"); return false; }

      const resolver = resolveInjection ?? resolveResetInjection ?? ((input) => defaultResetInjection({
        ...input, loadPrepare, loadSpecItOut, inspectSpecification,
      }));
      const resolved = await resolver({ ctx, command });
      const injection = typeof resolved === "string" ? resolved : resolved?.content;
      if (typeof injection !== "string" || !injection.trim()) throw new TypeError("Ralph context reset requires a non-empty skill injection");
      const transitionDetails = typeof resolved === "object" && resolved?.details && typeof resolved.details === "object" ? resolved.details : {};
      const requestId = createRequestId();
      pi.appendEntry(RESET_MARKER_TYPE, {
        source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command,
      });
      const marker = ctx.sessionManager.getBranch().at(-1);
      if (marker?.type !== "custom" || marker.customType !== RESET_MARKER_TYPE || marker.data?.requestId !== requestId || !marker.id) {
        throw new Error("Ralph reset marker was not durably observable");
      }

      const customInstructions = resetCompactionInstructions(requestId);
      pending = { requestId, markerId: marker.id, customInstructions, injection, command, transitionDetails };
      appendState("compacting", requestId, { markerId: marker.id, command });

      const injectSkills = (mode) => {
        const skillMessage = {
          role: "custom",
          customType: RESET_MESSAGE_TYPE,
          content: pending?.injection ?? injection,
          display: false,
          details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, mode, command, ...transitionDetails },
          timestamp: Date.now(),
        };
        if (pending?.requestId === requestId) {
          pending.stage = "prepare_pending";
          pending.cleanNextContext = true;
          pending.prepareMessage = skillMessage;
        }
        appendState("prepare_pending", requestId, { mode, command });
        try {
          pi.sendMessage(skillMessage, { triggerTurn: true, deliverAs: "followUp" });
          onAdmitted?.(skillMessage);
          ctx.ui.notify(command === "plan" ? "Ralph planning started." : "Ralph reset started.", "info");
        } catch (error) {
          appendState("failed", requestId, { reason: "skill_admission_failed", command });
          clearPending();
          ctx.ui.notify("Ralph context reset failed before prepare was admitted; retry the command.", "error");
        }
      };

      ctx.compact({
        customInstructions,
        onComplete: (result) => {
          if (!pending || pending.requestId !== requestId) return;
          if (result.summary !== "" || result.firstKeptEntryId !== marker.id) {
            appendState("failed", requestId, { reason: "unexpected_compaction_result", command });
            clearPending();
            ctx.ui.notify("Ralph context reset returned an unexpected boundary; retry the command.", "error");
            return;
          }
          injectSkills("compaction");
        },
        onError: (error) => {
          if (!pending || pending.requestId !== requestId) return;
          const reason = String(error?.message ?? error);
          if (SHORT_COMPACTION_REASONS.some((expected) => reason.includes(expected))) { injectSkills("projection-fallback"); return; }
          appendState("failed", requestId, { reason: "compaction_failed", command });
          clearPending();
          ctx.ui.notify("Ralph context reset failed before its skill prompt was delivered; retry the command.", "error");
        },
      });
      return true;
    };

    pi.registerCommand("reset", {
      description: "Reset model-visible context in this session and re-enter the current Ralph phase",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /reset");
        await requestBoundary({ ctx, command: "reset" });
      },
    });

    pi.on("session_start", (_event, ctx) => recover(ctx));
    pi.on("session_before_compact", (event) => {
      if (!pending || event.customInstructions !== pending.customInstructions) return;
      const marker = event.branchEntries.find((entry) => entry.id === pending.markerId);
      if (!marker || marker.type !== "custom" || marker.customType !== RESET_MARKER_TYPE || marker.data?.requestId !== pending.requestId) return { cancel: true };
      return { compaction: {
        summary: "", firstKeptEntryId: marker.id, tokensBefore: event.preparation.tokensBefore,
        details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: pending.requestId, command: pending.command },
      } };
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
        appendState("failed", pending.requestId, { reason: finalAssistant.stopReason === "aborted" ? "provider_aborted" : "provider_error", boundaryExists: true, command: pending.command });
      } else appendState("completed", pending.requestId, { mode: "settled", command: pending.command });
      clearPending();
    });
    pi.on("session_shutdown", (event) => {
      if (!pending) return;
      appendState("interrupted", pending.requestId, { reason: event.reason, command: pending.command });
      clearPending();
    });

    return Object.freeze({ requestBoundary });
  };
}

export default createResetExtension();
