import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { createResetExtension } from "./reset-extension.js";
import { formatPrepareInjection, loadPrepareSkill } from "./reset-skill.js";
import {
  formatPlanningInjection, hasPlanningStartupBoundary, inspectActivePlan, inspectBlockedPlanningDocuments,
  loadPlanSkill, PLANNING_MESSAGE_TYPE, PLANNING_PROTOCOL_VERSION, PLANNING_STARTUP_MESSAGE_TYPE,
} from "./planning.js";
import {
  formatSpecificationInjection, hasStartupPrepareBoundary, inspectActiveSpecification, loadSpecItOutSkill,
  SPECIFICATION_MESSAGE_TYPE, SPECIFICATION_PROTOCOL_VERSION, STARTUP_PREPARE_MESSAGE_TYPE,
} from "./specification.js";
import {
  BLOCKED_MESSAGE_TYPE, EXECUTION_MESSAGE_TYPE, EXECUTION_PROTOCOL_VERSION, EXECUTION_STATE_ENTRY_TYPE,
  RESTORED_BLOCKED_GUIDANCE,
  beginExecution, executionContextProjection, formatBlockedInjection, formatExecutionInjection,
  latestExecutionState, latestGoalState, loadBlockedSkill, loadExecuteSkill, nextExecutionState, reconcileGoalState,
} from "./execution.js";
import { appendExecutionLogEntry } from "./execution-log.js";
import {
  adoptRestoredPlanningDocuments, archivePlanningDocuments, blockPlanningDocuments,
  inspectBlockedPlanningTransaction, inspectRestoredPlanningTransaction, unblockPlanningDocuments,
  verifyAdoptedPlanningDocuments,
} from "./planning-transaction.js";
import { isFinalNormalAssistantTurn } from "./cycle-boundary-poc.js";
import { RESET_MESSAGE_TYPE } from "./reset-context.js";

function assertState(value, label) {
  if (!new Set(["absent", "existing"]).has(value)) throw new TypeError(`unsupported ${label} state: ${value}`);
}
function assistantText(message) {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content.trim();
  return Array.isArray(message.content) ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n").trim() : "";
}
function latestSessionPhase(entries, sessionId) {
  const execution = latestExecutionState(entries, sessionId);
  if (execution.phase === "execution" && execution.status !== "inactive") return "execution";
  if (execution.phase === "blocked") return "blocked";
  if (!Array.isArray(entries) || !sessionId) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom_message" || entry.details?.source !== "prime-ralph" || entry.details?.sessionId !== sessionId) continue;
    if (entry.details.workflowPhase === "planning" && [PLANNING_MESSAGE_TYPE, PLANNING_STARTUP_MESSAGE_TYPE, RESET_MESSAGE_TYPE].includes(entry.customType)) return "planning";
    if (entry.details.workflowPhase === "specification" || entry.customType === STARTUP_PREPARE_MESSAGE_TYPE) return "specification";
  }
  return undefined;
}

const lifecycleParameters = Type.Object({
  action: Type.Union(["status", "continue", "wait", "ready", "block", "complete", "unblock", "confirm-forward"].map((value) => Type.Literal(value))),
  lifecycleId: Type.Optional(Type.String({ maxLength: 200 })),
  cycle: Type.Optional(Type.Integer({ minimum: 0 })),
  waitId: Type.Optional(Type.String({ maxLength: 200 })),
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
  readiness: Type.Optional(Type.String({ maxLength: 1000 })),
  unblockCondition: Type.Optional(Type.String({ maxLength: 1000 })),
  wakeupId: Type.Optional(Type.String({ maxLength: 300 })),
  wakeupsStopped: Type.Optional(Type.Boolean()),
  archive: Type.Optional(Type.Boolean()),
  archiveName: Type.Optional(Type.String({ maxLength: 120 })),
  provenanceId: Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: false });

export function createWorkflowExtension({
  loadPrepare = loadPrepareSkill, loadSpecItOut = loadSpecItOutSkill, loadPlan = loadPlanSkill,
  loadExecute = loadExecuteSkill, loadBlocked = loadBlockedSkill,
  inspectSpecification = inspectActiveSpecification, inspectPlan = inspectActivePlan,
  inspectBlocked = inspectBlockedPlanningDocuments, inspectBlockedProof = inspectBlockedPlanningTransaction,
  inspectRestoredProof = inspectRestoredPlanningTransaction,
  blockDocuments = blockPlanningDocuments, unblockDocuments = unblockPlanningDocuments,
  adoptRestoredDocuments = adoptRestoredPlanningDocuments, verifyAdoptedDocuments = verifyAdoptedPlanningDocuments,
  archiveDocuments = archivePlanningDocuments,
  appendLog = appendExecutionLogEntry, createRequestId = randomUUID, now = () => new Date(),
} = {}) {
  return function workflowExtension(pi) {
    const startupSessions = new Set(), sessionPhases = new Map(), executionStates = new Map(), activeLifecycleTurns = new Map(), activeBlockedTurns = new Set(), executionRoundBoundaries = new Map(), lifecycleCloseoutWaiters = new Map();
    const sessionId = (ctx) => ctx.sessionManager.getSessionId();
    const closeoutIdentity = (message) => JSON.stringify([message?.timestamp ?? null, message?.stopReason ?? null, assistantText(message)]);
    const finalAssistantImmediatelyBefore = (messages, beforeIndex) => {
      const message = messages[beforeIndex - 1];
      return isFinalNormalAssistantTurn({ type: "turn_end", message }) ? message : null;
    };
    const waitForLifecycleCloseout = (id, message) => {
      const identity = closeoutIdentity(message), existing = lifecycleCloseoutWaiters.get(id);
      if (existing?.identity === identity) return existing.promise;
      let resolve;
      const promise = new Promise((settle) => { resolve = settle; });
      lifecycleCloseoutWaiters.set(id, { identity, promise, resolve });
      return promise;
    };
    const settleLifecycleCloseout = (id, message = null) => {
      const waiter = lifecycleCloseoutWaiters.get(id);
      if (!waiter || (message && waiter.identity !== closeoutIdentity(message))) return;
      lifecycleCloseoutWaiters.delete(id); waiter.resolve();
    };
    const branch = (ctx) => ctx.sessionManager.getBranch();
    const rawExecution = (ctx) => {
      const id = sessionId(ctx);
      const state = executionStates.get(id) ?? latestExecutionState(branch(ctx), id);
      executionStates.set(id, state); return state;
    };
    const persistExecution = (ctx, state) => {
      pi.appendEntry(EXECUTION_STATE_ENTRY_TYPE, state); executionStates.set(sessionId(ctx), state); return state;
    };
    const hasPendingTerminalLog = (state) => ["block", "complete"].includes(state.pendingDecision?.action);
    const finishPendingExecutionLog = (ctx, state) => {
      const pending = state.pendingDecision;
      if (!hasPendingTerminalLog(state) || typeof pending.finalAssistantMessage !== "string" || !pending.finalAssistantMessage.trim() || typeof pending.timestamp !== "string") return state;
      appendLog({ cwd: ctx.cwd, sessionId: sessionId(ctx), lifecycleId: state.lifecycleId, action: pending.action, phase: "execute", cycle: pending.cycle, finalAssistantMessage: pending.finalAssistantMessage, timestamp: new Date(pending.timestamp) });
      return persistExecution(ctx, nextExecutionState(state, { pendingDecision: null }));
    };
    const requireTerminalLogReady = (state) => {
      if (hasPendingTerminalLog(state)) throw new Error("the prior terminal execution pass has not captured a valid final assistant message for its durable log closeout; preserve the session and retry recovery before another workflow transition");
      return state;
    };
    const execution = (ctx, { reconcile = true } = {}) => {
      let current = rawExecution(ctx);
      if (!reconcile) return current;
      current = finishPendingExecutionLog(ctx, current);
      if (hasPendingTerminalLog(current)) return current;
      const goalReconciled = reconcileGoalState(current, latestGoalState(branch(ctx)));
      const reconciled = goalReconciled === current ? current : persistExecution(ctx, goalReconciled);
      return reconcilePlanningLocation(ctx, reconciled);
    };
    const goal = (ctx) => latestGoalState(branch(ctx));
    const blockedState = (ctx) => {
      const blocked = inspectBlocked({ cwd: ctx.cwd });
      if (!new Set(["absent", "partial", "complete"]).has(blocked.state)) throw new TypeError(`unsupported blocked planning state: ${blocked.state}`);
      return blocked;
    };
    const requireBlockedProof = (ctx, expectedLifecycleId) => {
      const proof = inspectBlockedProof({ cwd: ctx.cwd });
      if (proof.state !== "complete") throw new Error(`blocked planning document transaction is ${proof.state}; only a complete current transaction can enter blocked interaction`);
      if (expectedLifecycleId && proof.lifecycleId !== expectedLifecycleId) throw new Error("blocked planning provenance does not match the current Ralph lifecycle");
      return proof;
    };
    const requireNoBlocked = (ctx) => {
      const blocked = blockedState(ctx);
      if (blocked.state !== "absent") throw new Error("Ralph has blocked planning documents; resolve them through the blocked workflow before using this command.");
    };
    const isRestoredRecovery = (state) => ["active-pair-restored", "active-pair-adoption-pending"].includes(state?.recovery) && state.forwardConfirmed !== true && typeof state.provenanceId === "string";
    const restoredRecoveryMessage = "The specification and execution plan were moved back to their active folder outside Ralph's normal unblock step. Ralph must verify that they are the same files and that the original blocker is resolved before execution can restart.";
    const requireRestoredProof = (ctx, state) => {
      const proof = inspectRestoredProof({ cwd: ctx.cwd });
      if (state?.recovery === "active-pair-adoption-pending" && ["absent", "unproven"].includes(proof.state) && state.adoption?.provenance) {
        verifyAdoptedDocuments({ cwd: ctx.cwd, lifecycleId: state.provenanceId, provenance: state.adoption.provenance });
        return { state: "complete", lifecycleId: state.provenanceId, provenance: state.adoption.provenance, adopted: true };
      }
      if (proof.state !== "complete") {
        const guidance = {
          absent: "both active planning files are missing",
          partial: "only one active planning file is present",
          unproven: "the saved blocked-work record is missing",
          stale: "the saved blocked-work record is invalid",
          modified: "one or both active planning files differ from the saved blocked versions",
          conflict: "blocked and active planning files both exist",
        };
        throw new Error(`${restoredRecoveryMessage} Verification stopped because ${guidance[proof.state] ?? `the restored files are ${proof.state}`}. Preserve the files and repair that exact condition before retrying.`);
      }
      if (state?.provenanceId && proof.lifecycleId !== state.provenanceId) throw new Error(`${restoredRecoveryMessage} The saved record belongs to different blocked work. Preserve the files and inspect the conflicting record before retrying.`);
      return proof;
    };
    const reconcilePlanningLocation = (ctx, state) => {
      const unresolved = state.phase === "blocked" || (state.status === "inactive" && state.provenanceId && state.forwardConfirmed !== true);
      if (!unresolved) return state;
      const blocked = blockedState(ctx);
      if (blocked.state === "partial") throw new Error("Only one planning file is in .ralph/plans/blocked/. Restore or complete the exact specification and execution plan pair before Ralph can continue.");
      if (blocked.state === "complete") {
        const proof = requireBlockedProof(ctx, state.provenanceId);
        if (!isRestoredRecovery(state)) return state;
        return persistExecution(ctx, nextExecutionState(state, { phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, pendingDecision: null, provenanceId: proof.lifecycleId, forwardConfirmed: false, blockedContextEstablished: false, blockedContextMode: "blocked", recovery: null, adoption: null }));
      }
      if (state.recovery === "active-pair-adoption-pending") return state;
      const restored = inspectRestoredProof({ cwd: ctx.cwd });
      if (restored.state !== "complete") {
        if (state.phase === "blocked") requireRestoredProof(ctx, state);
        return state;
      }
      if (state.provenanceId && restored.lifecycleId !== state.provenanceId) throw new Error(`${restoredRecoveryMessage} The saved record belongs to different blocked work. Preserve the files and inspect the conflicting record before retrying.`);
      return persistExecution(ctx, nextExecutionState(state, { phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, pendingDecision: null, wait: null, provenanceId: restored.lifecycleId, forwardConfirmed: false, blockedContextEstablished: false, blockedContextMode: "restored", recovery: "active-pair-restored", adoption: null }));
    };
    const hasRestoredBoundary = (entries, id, provenanceId) => Array.isArray(entries) && entries.some((entry) => entry?.type === "custom_message" && entry.customType === BLOCKED_MESSAGE_TYPE && entry.details?.source === "prime-ralph" && entry.details?.protocolVersion === EXECUTION_PROTOCOL_VERSION && entry.details?.sessionId === id && entry.details?.invocationMode === "blocked-restored" && entry.details?.provenanceId === provenanceId);
    const setPhase = (ctx, phase) => sessionPhases.set(sessionId(ctx), phase);
    const getPhase = (ctx) => {
      const id = sessionId(ctx), live = execution(ctx);
      if (live.phase === "blocked") return "blocked";
      if (live.phase === "execution" && live.status !== "inactive") return "execution";
      const known = sessionPhases.get(id) ?? latestSessionPhase(branch(ctx), id);
      if (known && !["execution", "blocked"].includes(known)) { sessionPhases.set(id, known); return known; }
      const specification = inspectSpecification({ cwd: ctx.cwd }); assertState(specification.state, "specification");
      const selected = specification.state === "existing" ? "planning" : "specification";
      sessionPhases.set(id, selected); return selected;
    };
    const validatePair = (ctx) => {
      const specification = inspectSpecification({ cwd: ctx.cwd }); assertState(specification.state, "specification");
      const plan = inspectPlan({ cwd: ctx.cwd }); assertState(plan.state, "execution plan");
      return { specification, plan };
    };
    const executeContent = (ctx, state, mode) => {
      const { specification, plan } = validatePair(ctx);
      if (specification.state !== "existing" || plan.state !== "existing") throw new Error("Ralph execution requires both exact active planning documents.");
      const prepare = loadPrepare({ cwd: ctx.cwd }), skill = loadExecute({ cwd: ctx.cwd });
      return `${formatPrepareInjection(prepare)}\n${formatExecutionInjection(skill, { mode, lifecycleId: state.lifecycleId, cycle: state.cycle, status: state.status, driverGoalId: state.driverGoalId })}`;
    };
    const blockedContent = (ctx, mode, provenanceId) => {
      const prepare = loadPrepare({ cwd: ctx.cwd }), skill = loadBlocked({ cwd: ctx.cwd });
      return `${formatPrepareInjection(prepare)}\n${formatBlockedInjection(skill, { mode, provenanceId })}`;
    };

    const restoredContent = (ctx, provenanceId) => `${blockedContent(ctx, "blocked-restored", provenanceId)}
<prime-ralph-restored-guidance>${RESTORED_BLOCKED_GUIDANCE}</prime-ralph-restored-guidance>`;

    let resetRuntime;
    resetRuntime = createResetExtension({
      loadPrepare, loadSpecItOut, inspectSpecification, createRequestId,
      handleReset: async ({ ctx }) => {
        const state = requireTerminalLogReady(execution(ctx));
        if (state.phase === "execution" && state.status === "running") {
          persistExecution(ctx, nextExecutionState(state, { resetRequested: true }));
          if (!ctx.isIdle()) pi.sendUserMessage("<prime-ralph-reset-request>Finish or safely stop the current operation, then make the required Ralph lifecycle decision at the earliest eligible boundary. Do not start unrelated work.</prime-ralph-reset-request>", { deliverAs: "steer" });
          ctx.ui.notify("Ralph execution reset is requested for the next eligible execution boundary.", "info"); return true;
        }
        if (state.status === "waiting") {
          ctx.ui.notify("Ralph execution is waiting; reset is deferred until the recorded work is ready.", "warning"); return true;
        }
        return false;
      },
      resolveResetInjection: ({ ctx }) => {
        const state = requireTerminalLogReady(execution(ctx));
        if (isRestoredRecovery(state)) {
          const proof = requireRestoredProof(ctx, state);
          return { content: restoredContent(ctx, proof.lifecycleId), details: { workflowPhase: "planning", invocationMode: "blocked-restored", recovery: "active-pair-restored", provenanceId: proof.lifecycleId, sessionId: sessionId(ctx) } };
        }
        if (state.phase === "blocked") {
          const proof = requireBlockedProof(ctx, state.provenanceId);
          return { content: blockedContent(ctx, "blocked-reset", proof.lifecycleId), details: { workflowPhase: "blocked", invocationMode: "blocked-reset", provenanceId: proof.lifecycleId, sessionId: sessionId(ctx) } };
        }
        if (state.phase === "execution" && state.status === "paused") {
          return { content: executeContent(ctx, state, "execution-reset-paused"), triggerTurn: false, details: { workflowPhase: "execution", invocationMode: "execution-reset-paused", lifecycleId: state.lifecycleId, cycle: state.cycle, sessionId: sessionId(ctx) } };
        }
        requireNoBlocked(ctx);
        const phase = getPhase(ctx), specification = inspectSpecification({ cwd: ctx.cwd }); assertState(specification.state, "specification");
        const prepare = loadPrepare({ cwd: ctx.cwd });
        if (phase === "specification") {
          const skill = specification.state === "existing" ? loadSpecItOut({ cwd: ctx.cwd }) : undefined;
          return { content: skill ? `${formatPrepareInjection(prepare)}\n${formatSpecificationInjection(skill, "specification-reset-existing")}` : formatPrepareInjection(prepare), details: { workflowPhase: "specification", invocationMode: skill ? "specification-reset-existing" : "specification-new", sessionId: sessionId(ctx) } };
        }
        if (specification.state !== "existing") throw new Error("Ralph planning reset requires an active specification at .ralph/plans/SPECIFICATION.md");
        const plan = inspectPlan({ cwd: ctx.cwd }); assertState(plan.state, "execution plan");
        const skill = loadPlan({ cwd: ctx.cwd }), mode = plan.state === "existing" ? "planning-reset-existing" : "planning-reset-new";
        return { content: `${formatPrepareInjection(prepare)}\n${formatPlanningInjection(skill, mode)}`, details: { workflowPhase: "planning", invocationMode: mode, planState: plan.state, sessionId: sessionId(ctx) } };
      },
    })(pi);

    pi.registerTool({
      name: "ralph_lifecycle", label: "Ralph Lifecycle",
      description: "Inspect or make one authoritative semantic transition in the current Ralph execution or blocked lifecycle. Use only as directed by the injected execute or blocked skill.",
      promptSnippet: "Use ralph_lifecycle exactly once at the semantic end of a Ralph execution pass, or for the matching blocked/waiting control.",
      parameters: lifecycleParameters, executionMode: "sequential",
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        let state = finishPendingExecutionLog(ctx, execution(ctx, { reconcile: false }));
        const result = (text, details = {}) => ({ content: [{ type: "text", text }], details: { protocolVersion: EXECUTION_PROTOCOL_VERSION, ...details } });
        if (params.action === "status") {
          if (state.phase === "blocked") {
            const reason = typeof state.block?.reason === "string" && state.block.reason.trim() ? state.block.reason.trim().slice(0, 1000) : "not recorded; inspect the planning documents or ask the user";
            const condition = typeof state.block?.unblockCondition === "string" && state.block.unblockCondition.trim() ? state.block.unblockCondition.trim().slice(0, 1000) : "not recorded; inspect the planning documents or ask the user";
            return result(`Ralph is resolving blocked work.
Recorded blocker: ${reason}
Condition required before execution can restart: ${condition}`, { state });
          }
          return result(`Ralph is ${state.status} in the ${state.phase} workflow.`, { state });
        }
        requireTerminalLogReady(state);
        if (["unblock", "confirm-forward"].includes(params.action)) {
          if (state.phase !== "blocked" && !(params.action === "confirm-forward" && state.phase === "planning")) throw new Error("Ralph is not resolving blocked work right now");
          if (!params.provenanceId || params.provenanceId !== state.provenanceId) throw new Error("This request refers to different or missing blocked work. Check Ralph's current status and retry with its current identifier.");
          if (params.action === "unblock") {
            if (isRestoredRecovery(state)) throw new Error("The planning files are already in the active folder. Check the original blocker, then use confirm-forward instead of moving them again.");
            const transaction = unblockDocuments({ cwd: ctx.cwd, lifecycleId: params.provenanceId });
            state = persistExecution(ctx, nextExecutionState(state, { phase: "planning", status: "inactive", pendingDecision: null, forwardConfirmed: false, blockedContextEstablished: false, blockedContextMode: null, recovery: null, adoption: null }));
            setPhase(ctx, "planning");
            return result("The specification and execution plan are back in the active folder. Confirm that the original blocker is resolved, then tell the user to run /execute.", { action: "unblock", transaction, state });
          }
          let transaction = null;
          if (state.phase === "blocked") {
            if (!isRestoredRecovery(state)) throw new Error("The planning files are still in the blocked folder. Resolve the blocker and restore them before confirming that execution can continue.");
            activeBlockedTurns.add(sessionId(ctx));
            let proof = requireRestoredProof(ctx, state);
            if (state.recovery !== "active-pair-adoption-pending") {
              state = persistExecution(ctx, nextExecutionState(state, { recovery: "active-pair-adoption-pending", adoption: { lifecycleId: state.provenanceId, provenance: proof.provenance } }));
            }
            if (proof.adopted !== true) transaction = adoptRestoredDocuments({ cwd: ctx.cwd, lifecycleId: params.provenanceId });
            else transaction = { operation: "verify-adopted", lifecycleId: params.provenanceId };
          }
          state = persistExecution(ctx, nextExecutionState(state, { phase: "planning", status: "inactive", pendingDecision: null, forwardConfirmed: true, blockedContextEstablished: false, blockedContextMode: null, recovery: null, adoption: null }));
          setPhase(ctx, "planning");
          return result("The planning files are verified and the original blocker is resolved. Ralph remains stopped until the user runs /execute.", { action: "confirm-forward", transaction, state });
        }

        if (!params.lifecycleId || params.lifecycleId !== state.lifecycleId || params.cycle !== state.cycle) throw new Error("Ralph lifecycle or cycle identifier is stale or missing");
        if (state.pendingDecision) throw new Error("this lifecycle turn already has a semantic decision");
        const nativeGoal = goal(ctx), goalActive = nativeGoal?.status === "active";
        if (params.action === "continue") {
          if (state.status !== "running") throw new Error("continue requires a running lifecycle");
          if (!goalActive) throw new Error("continue requires the native Prime Agent goal driver to remain active");
          state = persistExecution(ctx, nextExecutionState(state, { driverGoalId: nativeGoal.goalId, pendingDecision: { action: "continue", cycle: state.cycle } }));
          return result("Continuation accepted for this pass. Exactly one native-goal continuation may become the next clean execute round.", { action: "continue", state });
        }
        if (params.action === "wait") {
          if (!new Set(["running", "waiting"]).has(state.status)) throw new Error("wait requires a running or waiting lifecycle");
          if (goalActive || ["paused", "budget_limited"].includes(nativeGoal?.status)) throw new Error("wait requires the native goal driver to be completed first");
          if (!params.reason?.trim() || !params.readiness?.trim()) throw new Error("wait requires a bounded reason and readiness evidence");
          const waitId = state.status === "waiting" ? state.wait?.id : createRequestId();
          if (state.status === "waiting" && params.waitId !== waitId) throw new Error("waiting check identifier is stale or missing");
          state = persistExecution(ctx, nextExecutionState(state, { status: "waiting", driverGoalId: nativeGoal?.goalId ?? state.driverGoalId, pendingDecision: { action: "wait", cycle: state.cycle }, wait: { id: waitId, reason: params.reason.trim(), readiness: params.readiness.trim(), wakeupId: params.wakeupId ?? null } }));
          return result(`Waiting accepted with wait identifier ${waitId}. No execution round will be admitted until explicit readiness.`, { action: "wait", waitId, state });
        }
        if (params.action === "ready") {
          if (state.status !== "waiting" || !state.wait || params.waitId !== state.wait.id) throw new Error("ready requires the current waiting identifier");
          if (!goalActive) throw new Error("ready requires a newly active native Prime Agent goal driver");
          if (nativeGoal.goalId === state.driverGoalId) throw new Error("ready requires a new native goal identifier after waiting");
          state = persistExecution(ctx, nextExecutionState(state, { status: "running", driverGoalId: nativeGoal.goalId, pendingDecision: { action: "ready", cycle: state.cycle, waitId: state.wait.id }, wait: null }));
          return result("Readiness accepted. The same Ralph lifecycle and open cycle will resume exactly once.", { action: "ready", state });
        }
        if (params.action === "block") {
          if (!new Set(["running", "waiting"]).has(state.status)) throw new Error("block requires a running or waiting lifecycle");
          if (goalActive || ["paused", "budget_limited"].includes(nativeGoal?.status)) throw new Error("block requires the native goal driver to be completed first");
          if (!params.reason?.trim() || !params.unblockCondition?.trim() || params.wakeupsStopped !== true) throw new Error("block requires reason, unblock condition, and confirmed stopped wakeups");
          const transaction = blockDocuments({ cwd: ctx.cwd, lifecycleId: state.lifecycleId });
          state = persistExecution(ctx, nextExecutionState(state, { phase: "blocked", status: "inactive", pendingDecision: { action: "block", cycle: state.cycle }, provenanceId: state.lifecycleId, forwardConfirmed: false, blockedContextEstablished: false, wait: null, block: { reason: params.reason.trim(), unblockCondition: params.unblockCondition.trim() } }));
          setPhase(ctx, "blocked");
          return result("Blocked transition committed. Continuation is stopped; finish with the specific help request.", { action: "block", transaction, state });
        }
        if (params.action === "complete") {
          if (state.status !== "running") throw new Error("complete requires a running lifecycle");
          if (goalActive || ["paused", "budget_limited"].includes(nativeGoal?.status)) throw new Error("complete requires the native goal driver to be completed first");
          const transaction = params.archive === true ? archiveDocuments({ cwd: ctx.cwd, lifecycleId: state.lifecycleId, archiveName: params.archiveName }) : null;
          state = persistExecution(ctx, nextExecutionState(state, { phase: "planning", status: "inactive", pendingDecision: { action: "complete", cycle: state.cycle }, completion: { archived: Boolean(transaction), archiveName: params.archiveName ?? null }, wait: null, forwardConfirmed: true }));
          setPhase(ctx, "planning");
          return result(transaction ? "Execution completion and requested archive committed." : "Execution completion committed without forced archival.", { action: "complete", transaction, state });
        }
        throw new Error(`unsupported Ralph lifecycle action: ${params.action}`);
      },
    });

    pi.registerCommand("spec-it-out", {
      description: "Develop a new or existing Ralph specification in the current conversation",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /spec-it-out"); await ctx.waitForIdle();
        const live = requireTerminalLogReady(execution(ctx));
        if (live.status === "running") { ctx.ui.notify("Pause the active Ralph execution lifecycle with /goal pause before using /spec-it-out.", "warning"); return; }
        if (live.status === "waiting") { ctx.ui.notify("Ralph is waiting with its native goal already complete; establish readiness or explicitly cancel the lifecycle before using /spec-it-out.", "warning"); return; }
        if (isRestoredRecovery(live)) { ctx.ui.notify(`${restoredRecoveryMessage} Continue the unblock check or use /reset to restart it before editing the specification.`, "warning"); return; }
        if (live.phase === "blocked") {
          const proof = requireBlockedProof(ctx, live.provenanceId), skill = loadSpecItOut({ cwd: ctx.cwd }), mode = "specification-existing";
          const guidance = `<prime-ralph-blocked-specification>Blocked provenance ${proof.lifecycleId} makes .ralph/plans/blocked/SPECIFICATION.md the protected existing specification for this interaction. Discuss it, offer an explicitly approved in-place update there, or cancel. Do not offer future-specification creation and do not restore or resume execution through this command.</prime-ralph-blocked-specification>`;
          pi.sendMessage({ customType: SPECIFICATION_MESSAGE_TYPE, content: `${formatSpecificationInjection(skill, mode)}
${guidance}`, display: false, details: { source: "prime-ralph", protocolVersion: SPECIFICATION_PROTOCOL_VERSION, requestId: createRequestId(), command: "spec-it-out", mode, specificationState: "existing", specificationPath: ".ralph/plans/blocked/SPECIFICATION.md", workflowPhase: "blocked", provenanceId: proof.lifecycleId, sessionId: sessionId(ctx) } }, { triggerTurn: true, deliverAs: "followUp" });
          return;
        }
        requireNoBlocked(ctx);
        const specification = inspectSpecification({ cwd: ctx.cwd }); assertState(specification.state, "specification");
        const mode = specification.state === "existing" ? "specification-existing" : "specification-new", skill = loadSpecItOut({ cwd: ctx.cwd });
        pi.sendMessage({ customType: SPECIFICATION_MESSAGE_TYPE, content: formatSpecificationInjection(skill, mode), display: false, details: { source: "prime-ralph", protocolVersion: SPECIFICATION_PROTOCOL_VERSION, requestId: createRequestId(), command: "spec-it-out", mode, specificationState: specification.state, workflowPhase: getPhase(ctx), sessionId: sessionId(ctx) } }, { triggerTurn: true, deliverAs: "followUp" });
      },
    });

    pi.registerCommand("plan", {
      description: "Create or discuss the Ralph execution plan for the active specification",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /plan"); await ctx.waitForIdle();
        const live = requireTerminalLogReady(execution(ctx));
        if (live.status === "running") { ctx.ui.notify("Pause the active Ralph execution lifecycle with /goal pause before using /plan.", "warning"); return; }
        if (live.status === "waiting") { ctx.ui.notify("Ralph is waiting with its native goal already complete; establish readiness or explicitly cancel the lifecycle before using /plan.", "warning"); return; }
        if (isRestoredRecovery(live)) { ctx.ui.notify(`${restoredRecoveryMessage} Continue the unblock check or use /reset to restart it before editing the plan.`, "warning"); return; }
        if (live.phase === "blocked") { ctx.ui.notify("Resolve the blocked Ralph workflow before using /plan.", "warning"); return; }
        requireNoBlocked(ctx);
        const specification = inspectSpecification({ cwd: ctx.cwd }); assertState(specification.state, "specification");
        if (specification.state !== "existing") { ctx.ui.notify("Ralph planning requires an active specification at .ralph/plans/SPECIFICATION.md.", "warning"); return; }
        const plan = inspectPlan({ cwd: ctx.cwd }); assertState(plan.state, "execution plan");
        const phase = getPhase(ctx);
        if ((phase === "planning" || live.status === "paused") && plan.state === "existing") {
          const skill = loadPlan({ cwd: ctx.cwd }), mode = "planning-existing";
          pi.sendMessage({ customType: PLANNING_MESSAGE_TYPE, content: formatPlanningInjection(skill, mode), display: false, details: { source: "prime-ralph", protocolVersion: PLANNING_PROTOCOL_VERSION, requestId: createRequestId(), command: "plan", mode, specificationState: "existing", planState: "existing", workflowPhase: live.status === "paused" ? "execution" : "planning", sessionId: sessionId(ctx) } }, { triggerTurn: true, deliverAs: "followUp" });
          if (live.status !== "paused") setPhase(ctx, "planning"); return;
        }
        await resetRuntime.requestBoundary({ ctx, command: "plan", resolveInjection: ({ ctx: boundaryCtx }) => {
          requireNoBlocked(boundaryCtx); const currentSpec = inspectSpecification({ cwd: boundaryCtx.cwd }); assertState(currentSpec.state, "specification");
          if (currentSpec.state !== "existing") throw new Error("Ralph planning requires an active specification at .ralph/plans/SPECIFICATION.md");
          const currentPlan = inspectPlan({ cwd: boundaryCtx.cwd }); assertState(currentPlan.state, "execution plan");
          const prepare = loadPrepare({ cwd: boundaryCtx.cwd }), skill = loadPlan({ cwd: boundaryCtx.cwd }), mode = currentPlan.state === "existing" ? "planning-existing" : "planning-new";
          return { content: `${formatPrepareInjection(prepare)}\n${formatPlanningInjection(skill, mode)}`, details: { workflowPhase: "planning", invocationMode: mode, planState: currentPlan.state, sessionId: sessionId(boundaryCtx) } };
        }, onAdmitted: () => setPhase(ctx, "planning") });
      },
    });

    pi.registerCommand("execute", {
      description: "Start or resume the safe Ralph execution lifecycle",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /execute"); await ctx.waitForIdle();
        const blocked = blockedState(ctx);
        if (blocked.state !== "absent") { ctx.ui.notify("Ralph execution is unavailable while blocked planning documents exist; resolve the blocked workflow first.", "warning"); return; }
        const { specification, plan } = validatePair(ctx);
        if (specification.state !== "existing") { ctx.ui.notify("Ralph execution requires .ralph/plans/SPECIFICATION.md before /execute.", "warning"); return; }
        if (plan.state !== "existing") { ctx.ui.notify("Ralph execution requires .ralph/plans/EXECUTION_PLAN.md after the active specification before /execute.", "warning"); return; }
        let live = requireTerminalLogReady(execution(ctx));
        if (isRestoredRecovery(live)) { ctx.ui.notify(`${restoredRecoveryMessage} Continue the unblock check or use /reset to restart it. After Ralph verifies the files and blocker, run /execute again.`, "warning"); return; }
        if (["running", "waiting"].includes(live.status)) { ctx.ui.notify(`Ralph execution lifecycle ${live.lifecycleId} is already ${live.status}; no second lifecycle was created.`, "warning"); return; }
        if (live.status === "paused" && ["paused", "budget_limited"].includes(goal(ctx)?.status)) { ctx.ui.notify("Resume the same native Prime Agent goal with /goal resume; /execute will not create a second lifecycle.", "warning"); return; }
        if (live.status === "inactive" && live.provenanceId && live.forwardConfirmed !== true) { ctx.ui.notify("The planning files are back in the active folder, but the agent has not confirmed that the original blocker is resolved. Ask it to finish the unblock check, then run /execute again.", "warning"); return; }
        const starting = live.status === "inactive", nativeGoal = goal(ctx);
        if (starting && ["active", "paused", "budget_limited"].includes(nativeGoal?.status)) {
          ctx.ui.notify("Ralph execution cannot start while an unrelated native Prime Agent goal is active or paused; complete or clear that goal first.", "warning"); return;
        }
        if (!starting && live.driverGoalId && nativeGoal?.goalId && nativeGoal.goalId !== live.driverGoalId) {
          ctx.ui.notify("Ralph execution cannot resume through a different native Prime Agent goal; clear the conflicting goal first.", "warning"); return;
        }
        const replaceTerminalDriver = !starting && ["idle", "complete", "error"].includes(nativeGoal?.status);
        const proposed = starting ? beginExecution(live, { lifecycleId: createRequestId(), driverGoalId: null }) : nextExecutionState(live, { status: "running", driverGoalId: replaceTerminalDriver ? null : live.driverGoalId, pendingDecision: null, pauseReason: null });
        const mode = starting ? "execution-start" : "execution-resume";
        await resetRuntime.requestBoundary({ ctx, command: "execute", resolveInjection: ({ ctx: boundaryCtx }) => ({ content: executeContent(boundaryCtx, proposed, mode), details: { workflowPhase: "execution", invocationMode: mode, lifecycleId: proposed.lifecycleId, cycle: proposed.cycle, sessionId: sessionId(boundaryCtx) } }), onAdmitted: () => { persistExecution(ctx, proposed); setPhase(ctx, "execution"); } });
      },
    });

    pi.on("before_agent_start", (_event, ctx) => {
      const live = requireTerminalLogReady(execution(ctx)), id = sessionId(ctx);
      if (live.status === "waiting") activeLifecycleTurns.set(id, { kind: "waiting-check" });
      if (live.phase === "blocked" && live.blockedContextEstablished !== true) {
        if (isRestoredRecovery(live)) {
          const proof = requireRestoredProof(ctx, live);
          return { message: { customType: BLOCKED_MESSAGE_TYPE, content: restoredContent(ctx, proof.lifecycleId), display: false, details: { source: "prime-ralph", protocolVersion: EXECUTION_PROTOCOL_VERSION, requestId: createRequestId(), sessionId: sessionId(ctx), workflowPhase: "blocked", invocationMode: "blocked-restored", recovery: "active-pair-restored", provenanceId: proof.lifecycleId, preserveTrigger: true } } };
        }
        const proof = requireBlockedProof(ctx, live.provenanceId);
        return { message: { customType: BLOCKED_MESSAGE_TYPE, content: blockedContent(ctx, "blocked-start", proof.lifecycleId), display: false, details: { source: "prime-ralph", protocolVersion: EXECUTION_PROTOCOL_VERSION, requestId: createRequestId(), sessionId: sessionId(ctx), workflowPhase: "blocked", invocationMode: "blocked-start", provenanceId: proof.lifecycleId, preserveTrigger: true } } };
      }
    });

    pi.on("context", async (event, ctx) => {
      let live = execution(ctx), id = sessionId(ctx);
      const lastUserIndex = event.messages.findLastIndex((message) => message?.role === "user");
      const goalIndex = event.messages.findLastIndex((message) => message?.role === "custom" && message.customType === "goal_context" && message.details?.kind === "continuation");
      if (live.phase === "execution" && live.status === "running" && goalIndex > lastUserIndex) {
        const goalMessage = event.messages[goalIndex], goalId = goalMessage.details?.goalId, continuationsUsed = goalMessage.details?.continuationsUsed;
        if (!goalId || goalId !== live.driverGoalId || !Number.isInteger(continuationsUsed)) {
          ctx.abort(); persistExecution(ctx, nextExecutionState(live, { status: "paused", pendingDecision: null, wait: null, pauseReason: "stale or mismatched native goal continuation" }));
          ctx.ui.notify("Ralph rejected a stale or mismatched native goal continuation.", "error"); return { messages: [] };
        }
        const boundaryIdentity = `${goalId}:${continuationsUsed}`;
        if (live.admittedContinuation?.identity === boundaryIdentity && live.admittedContinuation?.cycle === live.cycle) {
          let message = executionRoundBoundaries.get(id)?.identity === boundaryIdentity ? executionRoundBoundaries.get(id).message : null;
          if (!message) {
            const mode = live.admittedContinuation.mode;
            message = { role: "custom", customType: EXECUTION_MESSAGE_TYPE, content: executeContent(ctx, live, mode), display: false, details: { source: "prime-ralph", protocolVersion: EXECUTION_PROTOCOL_VERSION, requestId: createRequestId(), sessionId: id, workflowPhase: "execution", invocationMode: mode, lifecycleId: live.lifecycleId, cycle: live.cycle, boundaryIdentity, preserveTrigger: false } };
            executionRoundBoundaries.set(id, { identity: boundaryIdentity, message });
          }
          return { messages: [message, ...event.messages.slice(goalIndex + 1)] };
        }
        const resetForBoundary = live.resetRequested === true, resumedForBoundary = live.resumed === true;
        if (live.pendingDecision?.action === "continue" && typeof live.pendingDecision.finalAssistantMessage !== "string") {
          const finalAssistantMessage = finalAssistantImmediatelyBefore(event.messages, goalIndex);
          if (!finalAssistantMessage) {
            ctx.abort(); persistExecution(ctx, nextExecutionState(live, { status: "paused", pendingDecision: null, wait: null, pauseReason: "native continuation arrived before lifecycle closeout" }));
            ctx.ui.notify("Ralph rejected a native continuation that arrived before lifecycle closeout.", "error"); return { messages: [] };
          }
          await waitForLifecycleCloseout(id, finalAssistantMessage);
          live = execution(ctx, { reconcile: false });
          if (live.pendingDecision?.action === "continue" && typeof live.pendingDecision.finalAssistantMessage !== "string" && live.status === "running") {
            ctx.abort(); persistExecution(ctx, nextExecutionState(live, { status: "paused", pendingDecision: null, wait: null, pauseReason: "native continuation arrived before lifecycle closeout" }));
            ctx.ui.notify("Ralph rejected a native continuation whose lifecycle closeout did not commit.", "error"); return { messages: [] };
          }
          if (live.phase !== "execution" || live.status !== "running") return { messages: [] };
        }
        if (live.pendingDecision?.action === "continue" && typeof live.pendingDecision.finalAssistantMessage === "string") {
          try {
            appendLog({ cwd: ctx.cwd, sessionId: id, lifecycleId: live.lifecycleId, action: live.pendingDecision.action, phase: "execute", cycle: live.cycle, finalAssistantMessage: live.pendingDecision.finalAssistantMessage, timestamp: new Date(live.pendingDecision.timestamp) });
            live = persistExecution(ctx, nextExecutionState(live, { cycle: live.cycle + 1, pendingDecision: null, resetRequested: false }));
          } catch (error) {
            ctx.abort(); persistExecution(ctx, nextExecutionState(live, { status: "paused", pendingDecision: null, wait: null, pauseReason: `execution boundary commit failed: ${error.message}` }));
            ctx.ui.notify(`Ralph execution boundary failed safely: ${error.message}`, "error"); return { messages: [] };
          }
        } else if (live.pendingDecision != null) {
          ctx.abort(); persistExecution(ctx, nextExecutionState(live, { status: "paused", pendingDecision: null, wait: null, pauseReason: "native continuation arrived before lifecycle closeout" }));
          ctx.ui.notify("Ralph rejected a native continuation that arrived before lifecycle closeout.", "error"); return { messages: [] };
        }
        const mode = resetForBoundary ? "execution-reset-running" : resumedForBoundary ? "execution-resume" : "execution-continue";
        live = persistExecution(ctx, nextExecutionState(live, { admittedContinuation: { identity: boundaryIdentity, goalId, continuationsUsed, cycle: live.cycle, mode }, resumed: false }));
        const message = { role: "custom", customType: EXECUTION_MESSAGE_TYPE, content: executeContent(ctx, resetForBoundary ? { ...live, resetRequested: true } : live, mode), display: false, details: { source: "prime-ralph", protocolVersion: EXECUTION_PROTOCOL_VERSION, requestId: createRequestId(), sessionId: id, workflowPhase: "execution", invocationMode: mode, lifecycleId: live.lifecycleId, cycle: live.cycle, boundaryIdentity, preserveTrigger: false } };
        executionRoundBoundaries.set(id, { identity: boundaryIdentity, message });
        return { messages: [message, ...event.messages.slice(goalIndex + 1)] };
      }
      if (live.pendingDecision?.action === "continue" && typeof live.pendingDecision.finalAssistantMessage === "string" && lastUserIndex > goalIndex) return;
      const newestRalphPhase = [...event.messages].reverse().find((message) => message?.role === "custom" && message.details?.source === "prime-ralph" && [EXECUTION_MESSAGE_TYPE, BLOCKED_MESSAGE_TYPE, PLANNING_MESSAGE_TYPE, PLANNING_STARTUP_MESSAGE_TYPE, SPECIFICATION_MESSAGE_TYPE, STARTUP_PREPARE_MESSAGE_TYPE, RESET_MESSAGE_TYPE].includes(message.customType));
      if (!newestRalphPhase) return;
      if (live.phase === "execution" && live.status !== "inactive" && newestRalphPhase.customType === EXECUTION_MESSAGE_TYPE) {
        const messages = executionContextProjection(event.messages, { allowedTypes: [EXECUTION_MESSAGE_TYPE], lifecycleId: live.lifecycleId });
        if (messages) return { messages };
      }
      if ((live.phase === "blocked" || activeBlockedTurns.has(id)) && newestRalphPhase.customType === BLOCKED_MESSAGE_TYPE) {
        const messages = executionContextProjection(event.messages, { allowedTypes: [BLOCKED_MESSAGE_TYPE], provenanceId: live.provenanceId });
        if (messages) return { messages };
      }
    });

    pi.on("turn_end", (event, ctx) => {
      if (!isFinalNormalAssistantTurn(event)) return;
      const id = sessionId(ctx); activeBlockedTurns.delete(id);
      const active = activeLifecycleTurns.get(id);
      if (!active) { settleLifecycleCloseout(id, event.message); return; }
      let live = execution(ctx, { reconcile: false });
      const decision = live.pendingDecision?.action, text = assistantText(event.message);
      try {
        if (decision === "continue") {
          live = persistExecution(ctx, nextExecutionState(live, { pendingDecision: { ...live.pendingDecision, finalAssistantMessage: text, timestamp: now().toISOString() } }));
        } else if (decision === "ready" || decision === "wait") {
          live = persistExecution(ctx, nextExecutionState(live, { pendingDecision: null }));
        } else if (decision === "block" || decision === "complete") {
          live = persistExecution(ctx, nextExecutionState(live, { pendingDecision: { ...live.pendingDecision, finalAssistantMessage: text, timestamp: now().toISOString() } }));
          live = finishPendingExecutionLog(ctx, live);
          requireTerminalLogReady(live);
        } else if (live.phase === "execution" && live.status === "running") {
          ctx.abort(); live = persistExecution(ctx, nextExecutionState(live, { status: "paused", pendingDecision: null, wait: null, pauseReason: "execution pass ended without a lifecycle decision" }));
          ctx.ui.notify("Ralph execution paused because the pass ended without an accepted lifecycle decision.", "error");
        }
      } catch (error) {
        ctx.abort();
        if (live.status !== "inactive") persistExecution(ctx, nextExecutionState(live, { status: "paused", pendingDecision: null, wait: null, pauseReason: `execution closeout failed: ${error.message}` }));
        ctx.ui.notify(`Ralph execution closeout failed safely: ${error.message}`, "error");
      } finally { activeLifecycleTurns.delete(id); settleLifecycleCloseout(id, event.message); }
    });

    pi.on("message_start", (event, ctx) => {
      const message = event.message, id = sessionId(ctx), live = execution(ctx, { reconcile: false });
      if ((message?.role === "user" && live.status === "waiting") || message?.customType === "goal_context" || message?.customType === EXECUTION_MESSAGE_TYPE || (message?.customType === RESET_MESSAGE_TYPE && message.details?.workflowPhase === "execution" && message.details?.invocationMode !== "execution-reset-paused")) {
        activeLifecycleTurns.set(id, { kind: "execute" });
      }
      if (message?.customType === BLOCKED_MESSAGE_TYPE) {
        activeBlockedTurns.add(id);
        if (live.phase === "blocked" && live.blockedContextEstablished !== true) persistExecution(ctx, nextExecutionState(live, { blockedContextEstablished: true, blockedContextMode: message.details?.invocationMode === "blocked-restored" ? "restored" : "blocked" }));
      }
    });

    pi.on("agent_end", (_event, ctx) => {
      const id = sessionId(ctx); activeBlockedTurns.delete(id); if (!activeLifecycleTurns.has(id)) return;
      const live = execution(ctx, { reconcile: false });
      if (live.phase === "execution" && live.status === "running") persistExecution(ctx, nextExecutionState(live, { status: "paused", pendingDecision: null, wait: null, pauseReason: "execution agent ended without normal closeout" }));
      activeLifecycleTurns.delete(id);
    });

    pi.on("session_shutdown", (event, ctx) => {
      settleLifecycleCloseout(sessionId(ctx));
      if (event.reason === "reload") return;
      const live = execution(ctx, { reconcile: false }); if (!["running", "waiting", "paused"].includes(live.status)) return;
      if (event.reason === "quit" && live.status === "waiting") persistExecution(ctx, nextExecutionState(live, { pendingDecision: null }));
      else if (event.reason === "quit") persistExecution(ctx, nextExecutionState(live, { status: "paused", pendingDecision: null, wait: null, pauseReason: "session quit" }));
      else persistExecution(ctx, nextExecutionState(live, { phase: "planning", status: "inactive", pendingDecision: null, wait: null, cancellation: `session ${event.reason}` }));
    });

    pi.on("session_start", (event, ctx) => {
      const id = sessionId(ctx); let live;
      try { live = latestExecutionState(branch(ctx), id); }
      catch (error) { ctx.ui.notify(`Ralph could not recover lifecycle state safely. ${error.message}`, "error"); return; }
      executionStates.set(id, live);
      let blocked, specification;
      try {
        live = finishPendingExecutionLog(ctx, live);
        requireTerminalLogReady(live);
        blocked = blockedState(ctx);
        if (blocked.state === "partial") throw new Error("Only one planning file is in .ralph/plans/blocked/. Restore or complete the exact specification and execution plan pair before Ralph can continue.");
        if (blocked.state === "complete") {
          const proof = requireBlockedProof(ctx);
          const alreadyCurrent = live.phase === "blocked" && !isRestoredRecovery(live) && live.provenanceId === proof.lifecycleId && live.blockedContextMode === "blocked";
          if (!alreadyCurrent) live = persistExecution(ctx, nextExecutionState(live, { phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, pendingDecision: null, provenanceId: proof.lifecycleId, forwardConfirmed: false, blockedContextEstablished: false, blockedContextMode: "blocked", recovery: null, adoption: null }));
          setPhase(ctx, "blocked");
          if (startupSessions.has(id) || (event.reason === "reload" && alreadyCurrent)) return;
          pi.sendMessage({ customType: BLOCKED_MESSAGE_TYPE, content: blockedContent(ctx, "blocked-start", proof.lifecycleId), display: false, details: { source: "prime-ralph", protocolVersion: EXECUTION_PROTOCOL_VERSION, requestId: createRequestId(), sessionId: id, workflowPhase: "blocked", invocationMode: "blocked-start", provenanceId: proof.lifecycleId, preserveTrigger: false } }, { triggerTurn: true, deliverAs: "followUp" });
          startupSessions.add(id); return;
        }
        specification = inspectSpecification({ cwd: ctx.cwd }); assertState(specification.state, "specification");
        const plan = inspectPlan({ cwd: ctx.cwd }); assertState(plan.state, "execution plan");
        const restored = inspectRestoredProof({ cwd: ctx.cwd });
        const recoveryCandidate = restored.state === "complete" || isRestoredRecovery(live) || (live.phase === "blocked" && live.provenanceId);
        if (recoveryCandidate) {
          if (live.recovery === "active-pair-adoption-pending" && ["absent", "unproven"].includes(restored.state) && live.adoption?.provenance) {
            verifyAdoptedDocuments({ cwd: ctx.cwd, lifecycleId: live.provenanceId, provenance: live.adoption.provenance });
            live = persistExecution(ctx, nextExecutionState(live, { phase: "planning", status: "inactive", pendingDecision: null, wait: null, forwardConfirmed: true, blockedContextEstablished: false, blockedContextMode: null, recovery: null, adoption: null }));
            setPhase(ctx, "planning");
          } else {
            const candidate = restored.state === "complete" ? { ...live, provenanceId: restored.lifecycleId } : live;
            const proof = requireRestoredProof(ctx, candidate);
            const recovery = live.recovery === "active-pair-adoption-pending" ? live.recovery : "active-pair-restored";
            const alreadyCurrent = live.phase === "blocked" && live.provenanceId === proof.lifecycleId && live.recovery === recovery && live.blockedContextMode === "restored";
            if (!alreadyCurrent) live = persistExecution(ctx, nextExecutionState(live, { phase: "blocked", status: "inactive", lifecycleId: null, cycle: 0, pendingDecision: null, wait: null, provenanceId: proof.lifecycleId, forwardConfirmed: false, blockedContextEstablished: false, blockedContextMode: "restored", recovery, adoption: live.adoption ?? null }));
            setPhase(ctx, "blocked");
            if (startupSessions.has(id) || hasRestoredBoundary(branch(ctx), id, proof.lifecycleId) || (event.reason === "reload" && alreadyCurrent)) return;
            pi.sendMessage({ customType: BLOCKED_MESSAGE_TYPE, content: restoredContent(ctx, proof.lifecycleId), display: false, details: { source: "prime-ralph", protocolVersion: EXECUTION_PROTOCOL_VERSION, requestId: createRequestId(), sessionId: id, workflowPhase: "blocked", invocationMode: "blocked-restored", recovery: "active-pair-restored", provenanceId: proof.lifecycleId, preserveTrigger: false } }, { triggerTurn: true, deliverAs: "followUp" });
            startupSessions.add(id); return;
          }
        } else if (["partial", "modified", "stale", "conflict"].includes(restored.state)) {
          requireRestoredProof(ctx, { ...live, provenanceId: restored.lifecycleId ?? live.provenanceId });
        } else if (live.phase === "execution" && live.status !== "inactive" && (specification.state !== "existing" || plan.state !== "existing")) {
          live = persistExecution(ctx, nextExecutionState(live, { phase: "planning", status: "inactive", pendingDecision: null, wait: null, cancellation: "active planning pair unavailable during recovery" }));
        }
      } catch (error) { ctx.ui.notify(`Ralph could not start safely. ${error.message}`, "error"); return; }
      const recovered = latestSessionPhase(branch(ctx), id); if (recovered && !["execution", "blocked"].includes(recovered)) sessionPhases.set(id, recovered);
      const phase = recovered && !["execution", "blocked"].includes(recovered) ? recovered : specification.state === "existing" ? "planning" : "specification";
      sessionPhases.set(id, phase);
      if (event.reason === "reload" || startupSessions.has(id) || hasStartupPrepareBoundary(branch(ctx), id) || hasPlanningStartupBoundary(branch(ctx), id)) return;
      try {
        const prepare = loadPrepare({ cwd: ctx.cwd }); let message;
        if (phase === "specification") message = { customType: STARTUP_PREPARE_MESSAGE_TYPE, content: formatPrepareInjection(prepare), display: false, details: { source: "prime-ralph", protocolVersion: SPECIFICATION_PROTOCOL_VERSION, requestId: createRequestId(), sessionId: id, mode: "specification-new", workflowPhase: "specification" } };
        else {
          const plan = inspectPlan({ cwd: ctx.cwd }); assertState(plan.state, "execution plan"); const skill = loadPlan({ cwd: ctx.cwd }), mode = plan.state === "existing" ? "planning-existing" : "planning-new";
          message = { customType: PLANNING_STARTUP_MESSAGE_TYPE, content: `${formatPrepareInjection(prepare)}
${formatPlanningInjection(skill, mode)}`, display: false, details: { source: "prime-ralph", protocolVersion: PLANNING_PROTOCOL_VERSION, requestId: createRequestId(), sessionId: id, mode, planState: plan.state, workflowPhase: "planning" } };
        }
        pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" }); startupSessions.add(id);
      } catch (error) { ctx.ui.notify(`Ralph ${phase} startup was not delivered: ${error.message}`, "error"); }
    });
  };
}

export default createWorkflowExtension();
