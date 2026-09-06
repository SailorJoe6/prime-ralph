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
  handleReset,
  createRequestId = randomUUID,
} = {}) {
  return function resetExtension(pi) {
    let pending;
    let activeRequestId;
    let settledAtTurnEnd;

    const appendState = (status, requestId, details = {}) => pi.appendEntry(RESET_STATE_TYPE, {
      source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status, ...details,
    });
    const clearPending = () => { pending = undefined; activeRequestId = undefined; };
    const failPending = (reason, error) => {
      const request = pending;
      if (!request) return;
      try { appendState("failed", request.requestId, { reason, command: request.command }); }
      finally {
        clearPending();
        try { request.onRejected?.({ requestId: request.requestId, markerId: request.markerId, command: request.command, reason, error }); } catch {}
      }
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
        ? "Recovered the completed Ralph context boundary without replaying its skill prompt."
        : compactionExists
          ? "Ralph context reset compacted before prepare was admitted; retry the command."
          : "An interrupted Ralph context reset was cancelled safely; retry the command.",
      boundaryExists ? "info" : "warning");
    };

    const requestBoundaryAtProviderBoundary = async ({
      ctx, command = "reset", resolveInjection, onAdmitted, onBeforeMarker, onMarker,
      onBeforeAdmission, onRejected, fallbackOnShort = true, waitForIdle = false, requestId: requestedId,
    } = {}) => {
      if (!ctx) throw new TypeError("context is required");
      if (pending) { ctx.ui.notify("A Ralph context reset is already pending.", "warning"); return false; }
      if (waitForIdle) {
        if (typeof ctx.waitForIdle !== "function") throw new TypeError("waitForIdle is required for an interactive reset boundary");
        await ctx.waitForIdle();
      }
      if (pending) { ctx.ui.notify("A Ralph context reset is already pending.", "warning"); return false; }

      const requestId = requestedId ?? createRequestId();
      if (typeof requestId !== "string" || !requestId || requestId.length > 200) throw new TypeError("Ralph context reset requestId must contain 1 to 200 characters");
      await onBeforeMarker?.({ requestId, command });
      const resolver = resolveInjection ?? resolveResetInjection ?? ((input) => defaultResetInjection({
        ...input, loadPrepare, loadSpecItOut, inspectSpecification,
      }));
      const resolved = await resolver({ ctx, command });
      const injection = typeof resolved === "string" ? resolved : resolved?.content;
      if (typeof injection !== "string" || !injection.trim()) throw new TypeError("Ralph context reset requires a non-empty skill injection");
      const transitionDetails = typeof resolved === "object" && resolved?.details && typeof resolved.details === "object" ? resolved.details : {};
      const triggerTurn = typeof resolved === "object" && resolved?.triggerTurn === false ? false : true;
      pi.appendEntry(RESET_MARKER_TYPE, {
        source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command,
      });
      const marker = ctx.sessionManager.getBranch().at(-1);
      if (marker?.type !== "custom" || marker.customType !== RESET_MARKER_TYPE || marker.data?.requestId !== requestId || !marker.id) {
        throw new Error("Ralph reset marker was not durably observable");
      }

      const customInstructions = resetCompactionInstructions(requestId);
      pending = { requestId, markerId: marker.id, customInstructions, injection, command, transitionDetails, fallbackOnShort, onBeforeAdmission, onAdmitted, onRejected, stage: "compacting" };
      const rejectBoundary = (reason, error) => failPending(reason, error);
      try {
        appendState("compacting", requestId, { markerId: marker.id, command });
        await onMarker?.({ requestId, markerId: marker.id, command });
      } catch (error) {
        rejectBoundary("compaction_setup_failed", error);
        throw error;
      }

      const injectSkills = (mode) => {
        if (!pending || pending.requestId !== requestId || pending.stage !== "compacting") return;
        const skillMessage = {
          role: "custom",
          customType: RESET_MESSAGE_TYPE,
          content: pending?.injection ?? injection,
          display: false,
          details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, mode, command, ...transitionDetails },
          timestamp: Date.now(),
        };
        try {
          onBeforeAdmission?.(skillMessage, { requestId, markerId: marker.id, command, mode });
          if (!pending || pending.requestId !== requestId || pending.stage !== "compacting") return;
          pending.stage = "prepare_pending";
          pending.cleanNextContext = true;
          pending.prepareMessage = skillMessage;
          appendState("prepare_pending", requestId, { mode, command });
          pi.sendMessage(skillMessage, { triggerTurn, deliverAs: "followUp" });
          if (!triggerTurn) {
            const durable = ctx.sessionManager.getBranch().filter((entry) => entry?.type === "custom_message" &&
              entry.customType === RESET_MESSAGE_TYPE && entry.details?.source === "prime-ralph" &&
              entry.details?.protocolVersion === RESET_PROTOCOL_VERSION && entry.details?.requestId === requestId);
            if (durable.length !== 1 || durable[0].details?.command !== command || durable[0].content !== skillMessage.content) {
              throw new Error("no-turn reset boundary was not durably observable");
            }
            onAdmitted?.(skillMessage);
            appendState("completed", requestId, { mode: "no-turn", command });
            clearPending();
          }
          ctx.ui.notify(command === "plan" ? "Ralph planning started." : "Ralph reset started.", "info");
        } catch (error) {
          rejectBoundary("skill_admission_failed", error);
          ctx.ui.notify("Ralph context reset failed before prepare was admitted; retry the command.", "error");
        }
      };

      try { ctx.compact({
        customInstructions,
        onComplete: (result) => {
          if (!pending || pending.requestId !== requestId || pending.stage !== "compacting") return;
          if (result.summary !== "" || result.firstKeptEntryId !== marker.id) {
            rejectBoundary("unexpected_compaction_result");
            ctx.ui.notify("Ralph context reset returned an unexpected boundary; retry the command.", "error");
            return;
          }
          injectSkills("compaction");
        },
        onError: (error) => {
          if (!pending || pending.requestId !== requestId || pending.stage !== "compacting") return;
          const reason = String(error?.message ?? error);
          if (fallbackOnShort && SHORT_COMPACTION_REASONS.some((expected) => reason.includes(expected))) { injectSkills("projection-fallback"); return; }
          const classified = SHORT_COMPACTION_REASONS.some((expected) => reason.includes(expected)) ? "compaction_unavailable" : "compaction_failed";
          rejectBoundary(classified, error);
          ctx.ui.notify("Ralph context reset failed before its skill prompt was delivered; retry the command.", "error");
        },
      }); } catch (error) {
        rejectBoundary("compaction_request_failed", error);
        return false;
      }
      return true;
    };

    const requestBoundary = (options = {}) => requestBoundaryAtProviderBoundary({ ...options, waitForIdle: true });

    pi.registerCommand("reset", {
      description: "Reset model-visible context in this session and re-enter the current Ralph phase",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /reset");
        if (handleReset && await handleReset({ ctx, requestBoundary })) return;
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
    pi.on("context", (event, ctx) => {
      if (pending?.stage === "prepare_pending" && pending.cleanNextContext) {
        const request = pending;
        const durable = ctx.sessionManager.getBranch().filter((entry) => entry?.type === "custom" &&
          entry.customType === RESET_STATE_TYPE && entry.data?.source === "prime-ralph" &&
          entry.data?.protocolVersion === RESET_PROTOCOL_VERSION && entry.data?.requestId === request.requestId &&
          entry.data?.status === "prepare_pending");
        const visible = event.messages.filter((message) => message?.role === "custom" &&
          message.customType === RESET_MESSAGE_TYPE && message.details?.source === "prime-ralph" &&
          message.details?.protocolVersion === RESET_PROTOCOL_VERSION && message.details?.requestId === request.requestId);
        if (visible.length === 0) return;
        const exact = durable.length === 1 && visible.length === 1 && visible[0].details?.command === request.command &&
          visible[0].content === request.prepareMessage?.content;
        if (!exact) {
          try { failPending("skill_boundary_not_durable"); } catch {}
          ctx.abort();
          return { messages: [] };
        }
        try {
          request.onAdmitted?.(request.prepareMessage);
          if (!pending || pending.requestId !== request.requestId) throw new Error("reset admission callback changed request ownership");
          pending.stage = "context_admitted";
          pending.cleanNextContext = false;
          return { messages: request.prepareMessage ? [request.prepareMessage] : [] };
        } catch (error) {
          try { failPending("skill_admission_commit_failed", error); } catch {}
          ctx.abort();
          return { messages: [] };
        }
      }
      return { messages: projectResetContext(event.messages) };
    });
    pi.on("message_start", (event) => {
      if (!pending || event.message?.customType !== RESET_MESSAGE_TYPE) return;
      if (event.message.details?.requestId === pending.requestId) activeRequestId = pending.requestId;
    });
    pi.on("turn_end", (event) => {
      if (!pending || activeRequestId !== pending.requestId) return;
      const message = event?.message;
      if (message?.role !== "assistant" || ["toolUse", "error", "aborted"].includes(message.stopReason)) return;
      // Release the in-memory single-flight before a native goal continuation can
      // reach provider context. Keep the request identity so agent_end can append
      // terminal telemetry after all turn_end handlers have run.
      settledAtTurnEnd = { requestId: pending.requestId, command: pending.command };
      clearPending();
    });
    pi.on("agent_end", (event) => {
      if (settledAtTurnEnd) {
        appendState("completed", settledAtTurnEnd.requestId, { mode: "settled", command: settledAtTurnEnd.command });
        settledAtTurnEnd = undefined;
        activeRequestId = undefined;
        return;
      }
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

    return Object.freeze({ requestBoundary, requestBoundaryAtProviderBoundary });
  };
}

export default createResetExtension();
