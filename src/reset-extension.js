import { randomUUID } from "node:crypto";
import { isQueuedToolHandoff } from "./cycle-boundary.js";
import { formatPrepareInjection, loadPrepareSkill } from "./reset-skill.js";
import { formatSpecificationInjection, inspectActiveSpecification, loadSpecItOutSkill } from "./specification.js";
import {
  hasResetBoundary,
  hasResetCompaction,
  latestResetState,
  latestResetStateForRequest,
  resetCompactionInstructions,
  RESET_MARKER_TYPE,
  RESET_MESSAGE_TYPE,
  RESET_PROTOCOL_VERSION,
  RESET_STATE_TYPE,
} from "./reset-context.js";

const TERMINAL_STATES = new Set(["completed", "interrupted", "failed", "recovered"]);

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
  hasActiveWorkflowTurn = () => false,
} = {}) {
  return function resetExtension(pi) {
    let pending;
    let activeRequestId;
    let settledAtTurnEnd;

    const appendState = (status, requestId, details = {}) => pi.appendEntry(RESET_STATE_TYPE, {
      source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, status, ...details,
    });
    const correlationDetails = (details = {}) => Object.fromEntries(["workflowPhase", "invocationMode", "sessionId", "lifecycleId", "cycle", "provenanceId"].filter((key) => details[key] != null).map((key) => [key, details[key]]));
    const clearPending = () => { pending = undefined; activeRequestId = undefined; };
    const admittedQueuedToolHandoff = (event, ctx) => Boolean(
      pending?.stage === "context_admitted" && activeRequestId === pending.requestId &&
      hasActiveWorkflowTurn(ctx) === true && isQueuedToolHandoff(event, ctx)
    );
    const failPending = (reason, error) => {
      const request = pending;
      if (!request) return;
      try { appendState("failed", request.requestId, { reason, command: request.command, ...request.identityDetails }); }
      finally {
        clearPending();
        try { request.onRejected?.({ requestId: request.requestId, markerId: request.markerId, command: request.command, reason, error }); } catch {}
      }
    };

    const recover = (ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const state = latestResetState(entries);
      if (!state) return;
      const boundaryExists = hasResetBoundary(entries, state.requestId);
      if (TERMINAL_STATES.has(state.status)) {
        if (boundaryExists && state.status !== "completed") ctx.ui.notify("A Ralph context boundary was not admitted and will remain blocked until an explicit retry compacts it away.", "warning");
        return;
      }
      const compactionExists = hasResetCompaction(entries, state.requestId);
      appendState(boundaryExists ? "interrupted" : "recovered", state.requestId, { boundaryExists, compactionExists, ...(state.command ? { command: state.command } : {}), ...correlationDetails(state) });
      clearPending();
      ctx.ui.notify(boundaryExists
        ? "An interrupted Ralph context boundary was not admitted; retry the command before continuing."
        : compactionExists
          ? "Ralph context reset compacted before prepare was admitted; retry the command."
          : "An interrupted Ralph context reset was cancelled safely; retry the command.", "warning");
    };

    const requestBoundaryAtProviderBoundary = async ({
      ctx, command = "reset", resolveInjection, onAdmitted, onBeforeMarker, onMarker,
      onBeforeAdmission, onRejected, ignoreCurrentAbort = false, requestId: requestedId,
    } = {}) => {
      if (!ctx) throw new TypeError("context is required");
      if (pending) { ctx.ui.notify("A Ralph context reset is already pending.", "warning"); return false; }
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
      const identityDetails = correlationDetails(transitionDetails);
      pi.appendEntry(RESET_MARKER_TYPE, {
        source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId, command, ...identityDetails,
      });
      const marker = ctx.sessionManager.getBranch().at(-1);
      if (marker?.type !== "custom" || marker.customType !== RESET_MARKER_TYPE || marker.data?.requestId !== requestId || !marker.id) {
        throw new Error("Ralph reset marker was not durably observable");
      }

      const customInstructions = resetCompactionInstructions(requestId);
      pending = { requestId, markerId: marker.id, customInstructions, injection, command, transitionDetails, identityDetails, onBeforeAdmission, onAdmitted, onRejected, ignoreCurrentAbort: ignoreCurrentAbort === true, stage: "compacting" };
      const rejectBoundary = (reason, error) => failPending(reason, error);
      try {
        appendState("compacting", requestId, { markerId: marker.id, command, ...identityDetails });
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
          appendState("prepare_pending", requestId, { mode, command, ...pending.identityDetails });
          pi.sendMessage(skillMessage, { triggerTurn, deliverAs: "followUp" });
          if (!triggerTurn) {
            const durable = ctx.sessionManager.getBranch().filter((entry) => entry?.type === "custom_message" &&
              entry.customType === RESET_MESSAGE_TYPE && entry.details?.source === "prime-ralph" &&
              entry.details?.protocolVersion === RESET_PROTOCOL_VERSION && entry.details?.requestId === requestId);
            if (durable.length !== 1 || durable[0].details?.command !== command || durable[0].content !== skillMessage.content) {
              throw new Error("no-turn reset boundary was not durably observable");
            }
            onAdmitted?.(skillMessage);
            appendState("completed", requestId, { mode: "no-turn", command, ...pending.identityDetails });
            clearPending();
          }
          const started = command === "plan" ? "Ralph planning started." : command === "execute" ? "Ralph execution started." : command === "execute-round" ? "Ralph next execution pass is ready." : command === "blocked-pass" ? "Ralph blocked interaction is ready." : "Ralph reset started.";
          ctx.ui.notify(started, "info");
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
          const short = reason.includes("Session is too short to compact");
          const already = reason.includes("Already compacted");
          const classified = short || already ? "compaction_unavailable" : "compaction_failed";
          rejectBoundary(classified, error);
          const transition = command === "blocked-pass" ? "blocked pass" : command === "execute-round" ? "next execution pass" : command === "execute" ? "execution pass" : command === "plan" ? "planning pass" : "reset";
          if (short && command === "reset") ctx.ui.notify("No reset was performed because the session is too short to warrant compaction.", "warning");
          else if (already && command === "reset") ctx.ui.notify("No reset was performed because the session was already compacted.", "warning");
          else if (short || already) ctx.ui.notify(`The Ralph ${transition} was not started because native compaction was unavailable.`, "warning");
          else ctx.ui.notify(`The Ralph ${transition} failed before its skill prompt was delivered; retry the command.`, "error");
        },
      }); } catch (error) {
        rejectBoundary("compaction_request_failed", error);
        return false;
      }
      return true;
    };

    const requestBoundary = (options = {}) => requestBoundaryAtProviderBoundary(options);
    let waitingForInteractiveIdle = false;
    const runInteractiveReset = async (ctx) => {
      if (handleReset && await handleReset({ ctx, requestBoundary })) return;
      await requestBoundary({ ctx, command: "reset" });
    };

    pi.registerCommand("reset", {
      description: "Reset model-visible context in this session and re-enter the current Ralph phase",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /reset");
        if (handleReset && await handleReset({ ctx, requestBoundary })) return;
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          if (waitingForInteractiveIdle || pending) { ctx.ui.notify("A Ralph context reset is already pending.", "warning"); return; }
          waitingForInteractiveIdle = true;
          ctx.ui.notify("Ralph context reset is queued behind active work.", "info");
          return;
        }
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
        details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: pending.requestId, command: pending.command, ...pending.identityDetails },
      } };
    });
    pi.on("context", (event, ctx) => {
      if (pending?.stage === "compacting") {
        ctx.abort();
        ctx.ui.notify("Ralph is still establishing a native context boundary; this provider request was not admitted.", "warning");
        return { messages: [] };
      }
      if (pending?.stage === "prepare_pending" && pending.cleanNextContext) {
        const request = pending;
        const durable = ctx.sessionManager.getBranch().filter((entry) => entry?.type === "custom" &&
          entry.customType === RESET_STATE_TYPE && entry.data?.source === "prime-ralph" &&
          entry.data?.protocolVersion === RESET_PROTOCOL_VERSION && entry.data?.requestId === request.requestId &&
          entry.data?.status === "prepare_pending");
        const visible = event.messages.filter((message) => message?.role === "custom" &&
          message.customType === RESET_MESSAGE_TYPE && message.details?.source === "prime-ralph" &&
          message.details?.protocolVersion === RESET_PROTOCOL_VERSION && message.details?.requestId === request.requestId);
        if (visible.length === 0) {
          ctx.abort();
          return { messages: [] };
        }
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
          return;
        } catch (error) {
          try { failPending("skill_admission_commit_failed", error); } catch {}
          ctx.abort();
          return { messages: [] };
        }
      }
      const entries = ctx.sessionManager.getBranch();
      const unsafe = event.messages.find((message) => {
        if (message?.role !== "custom" || message.customType !== RESET_MESSAGE_TYPE || message.details?.source !== "prime-ralph" || message.details?.protocolVersion !== RESET_PROTOCOL_VERSION) return false;
        if (pending?.requestId === message.details.requestId && pending.stage === "context_admitted") return false;
        if (settledAtTurnEnd?.requestId === message.details.requestId) return false;
        const requestId = message.details.requestId;
        const state = latestResetStateForRequest(entries, requestId);
        const durable = entries.filter((entry) => entry?.type === "custom_message" && entry.customType === RESET_MESSAGE_TYPE && entry.details?.source === "prime-ralph" && entry.details?.protocolVersion === RESET_PROTOCOL_VERSION && entry.details?.requestId === requestId);
        return state?.status !== "completed" || state.command !== message.details.command || durable.length !== 1 || durable[0].content !== message.content || durable[0].details?.command !== message.details.command || !hasResetCompaction(entries, requestId);
      });
      if (unsafe) {
        ctx.abort();
        ctx.ui.notify("A prior Ralph context boundary was not admitted; retry its command so native compaction can remove the stale boundary.", "error");
        return { messages: [] };
      }
      return;
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
      settledAtTurnEnd = { requestId: pending.requestId, command: pending.command, identityDetails: pending.identityDetails };
      clearPending();
    });
    pi.on("agent_end", async (event, ctx) => {
      if (waitingForInteractiveIdle && !ctx.hasPendingMessages()) {
        waitingForInteractiveIdle = false;
        try { await runInteractiveReset(ctx); }
        catch (error) { ctx.ui.notify(`Ralph context reset could not start after active work: ${error.message}`, "error"); }
      }
      if (settledAtTurnEnd) {
        const settled = settledAtTurnEnd;
        settledAtTurnEnd = undefined;
        activeRequestId = undefined;
        try { appendState("completed", settled.requestId, { mode: "settled", command: settled.command, ...settled.identityDetails }); }
        catch (error) {
          try { appendState("failed", settled.requestId, { reason: "completion_state_append_failed", boundaryExists: true, command: settled.command, ...settled.identityDetails }); } catch {}
          ctx.ui.notify("Ralph could not durably complete the context boundary; retry the command before continuing.", "error");
        }
        return;
      }
      if (!pending) return;
      const request = pending;
      const finalAssistant = [...(event.messages ?? [])].reverse().find((message) => message?.role === "assistant");
      if (request.ignoreCurrentAbort) {
        // The caller requested this boundary from a provider context that it
        // immediately aborted. Its agent_end is always the first one observed
        // for this transaction, even when no new aborted assistant was stored.
        request.ignoreCurrentAbort = false;
        return;
      }
      // Prime Agent ends the current Agent run after a tool batch when queued
      // steering is ready. Preserve this exact admitted request for the next run;
      // a later normal turn_end remains the only successful settlement.
      if (admittedQueuedToolHandoff(event, ctx)) return;
      if (activeRequestId !== request.requestId && request.stage !== "context_admitted") return;
      try {
        const reason = finalAssistant?.stopReason === "aborted" ? "provider_aborted" : finalAssistant?.stopReason === "error" ? "provider_error" : "missing_normal_turn_end";
        appendState("failed", request.requestId, { reason, boundaryExists: true, command: request.command, ...request.identityDetails });
      } catch (error) {
        ctx.ui.notify("Ralph could not durably settle the context boundary; retry the command before continuing.", "error");
      } finally {
        clearPending();
        activeRequestId = undefined;
      }
    });
    pi.on("session_shutdown", (event) => {
      waitingForInteractiveIdle = false;
      if (!pending) return;
      const request = pending;
      try { appendState("interrupted", request.requestId, { reason: event.reason, command: request.command, ...request.identityDetails }); }
      finally { clearPending(); activeRequestId = undefined; }
    });

    const relinquishAfterRecovery = (requestId) => {
      if (pending && pending.requestId !== requestId) throw new Error("Ralph recovery does not own the live reset request");
      if (settledAtTurnEnd && settledAtTurnEnd.requestId !== requestId) throw new Error("Ralph recovery does not own the settling reset request");
      waitingForInteractiveIdle = false; settledAtTurnEnd = undefined; clearPending();
    };
    return Object.freeze({ requestBoundary, requestBoundaryAtProviderBoundary, admittedQueuedToolHandoff, relinquishAfterRecovery });
  };
}

export default createResetExtension();
