import { randomUUID } from "node:crypto";
import { createResetExtension } from "./reset-extension.js";
import { formatPrepareInjection, loadPrepareSkill } from "./reset-skill.js";
import {
  formatPlanningInjection,
  hasPlanningStartupBoundary,
  inspectActivePlan,
  inspectBlockedPlanningDocuments,
  loadPlanSkill,
  PLANNING_MESSAGE_TYPE,
  PLANNING_PROTOCOL_VERSION,
  PLANNING_STARTUP_MESSAGE_TYPE,
} from "./planning.js";
import {
  formatSpecificationInjection,
  hasStartupPrepareBoundary,
  inspectActiveSpecification,
  loadSpecItOutSkill,
  SPECIFICATION_MESSAGE_TYPE,
  SPECIFICATION_PROTOCOL_VERSION,
  STARTUP_PREPARE_MESSAGE_TYPE,
} from "./specification.js";
import { RESET_MESSAGE_TYPE } from "./reset-context.js";

function assertState(value, label) {
  if (!new Set(["absent", "existing"]).has(value)) throw new TypeError(`unsupported ${label} state: ${value}`);
}

function latestSessionPhase(entries, sessionId) {
  if (!Array.isArray(entries) || !sessionId) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom_message" || entry.details?.source !== "prime-ralph" || entry.details?.sessionId !== sessionId) continue;
    if (entry.details.workflowPhase === "planning" && [PLANNING_MESSAGE_TYPE, PLANNING_STARTUP_MESSAGE_TYPE, RESET_MESSAGE_TYPE].includes(entry.customType)) return "planning";
    if (entry.details.workflowPhase === "specification" || entry.customType === STARTUP_PREPARE_MESSAGE_TYPE) return "specification";
  }
  return undefined;
}

export function createWorkflowExtension({
  loadPrepare = loadPrepareSkill,
  loadSpecItOut = loadSpecItOutSkill,
  loadPlan = loadPlanSkill,
  inspectSpecification = inspectActiveSpecification,
  inspectPlan = inspectActivePlan,
  inspectBlocked = inspectBlockedPlanningDocuments,
  createRequestId = randomUUID,
} = {}) {
  return function workflowExtension(pi) {
    const startupSessions = new Set();
    const sessionPhases = new Map();
    const sessionId = (ctx) => ctx.sessionManager.getSessionId();
    const ensureNoBlocked = (ctx) => {
      const blocked = inspectBlocked({ cwd: ctx.cwd });
      if (!new Set(["absent", "partial", "complete"]).has(blocked.state)) throw new TypeError(`unsupported blocked planning state: ${blocked.state}`);
      if (blocked.state !== "absent") throw new Error("Ralph blocked handling is not available in this release; resolve the blocked planning documents before using this workflow.");
    };
    const setPhase = (ctx, phase) => sessionPhases.set(sessionId(ctx), phase);
    const getPhase = (ctx) => {
      const id = sessionId(ctx);
      const known = sessionPhases.get(id) ?? latestSessionPhase(ctx.sessionManager.getBranch(), id);
      if (known) { sessionPhases.set(id, known); return known; }
      const specification = inspectSpecification({ cwd: ctx.cwd });
      assertState(specification.state, "specification");
      const selected = specification.state === "existing" ? "planning" : "specification";
      sessionPhases.set(id, selected);
      return selected;
    };

    const resetRuntime = createResetExtension({
      loadPrepare,
      loadSpecItOut,
      inspectSpecification,
      createRequestId,
      resolveResetInjection: ({ ctx }) => {
        ensureNoBlocked(ctx);
        const phase = getPhase(ctx);
        const specification = inspectSpecification({ cwd: ctx.cwd });
        assertState(specification.state, "specification");
        const prepare = loadPrepare({ cwd: ctx.cwd });
        if (phase === "specification") {
          const skill = specification.state === "existing" ? loadSpecItOut({ cwd: ctx.cwd }) : undefined;
          return {
            content: skill ? `${formatPrepareInjection(prepare)}
${formatSpecificationInjection(skill, "specification-reset-existing")}` : formatPrepareInjection(prepare),
            details: { workflowPhase: "specification", invocationMode: skill ? "specification-reset-existing" : "specification-new", sessionId: sessionId(ctx) },
          };
        }
        if (specification.state !== "existing") throw new Error("Ralph planning reset requires an active specification at .ralph/plans/SPECIFICATION.md");
        const plan = inspectPlan({ cwd: ctx.cwd });
        assertState(plan.state, "execution plan");
        const skill = loadPlan({ cwd: ctx.cwd });
        const mode = plan.state === "existing" ? "planning-reset-existing" : "planning-reset-new";
        return {
          content: `${formatPrepareInjection(prepare)}
${formatPlanningInjection(skill, mode)}`,
          details: { workflowPhase: "planning", invocationMode: mode, planState: plan.state, sessionId: sessionId(ctx) },
        };
      },
    })(pi);

    pi.registerCommand("spec-it-out", {
      description: "Develop a new or existing Ralph specification in the current conversation",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /spec-it-out");
        await ctx.waitForIdle();
        ensureNoBlocked(ctx);
        const specification = inspectSpecification({ cwd: ctx.cwd });
        assertState(specification.state, "specification");
        const mode = specification.state === "existing" ? "specification-existing" : "specification-new";
        const skill = loadSpecItOut({ cwd: ctx.cwd });
        pi.sendMessage({
          customType: SPECIFICATION_MESSAGE_TYPE,
          content: formatSpecificationInjection(skill, mode),
          display: false,
          details: { source: "prime-ralph", protocolVersion: SPECIFICATION_PROTOCOL_VERSION, requestId: createRequestId(), command: "spec-it-out", mode, specificationState: specification.state, workflowPhase: getPhase(ctx), sessionId: sessionId(ctx) },
        }, { triggerTurn: true, deliverAs: "followUp" });
      },
    });

    pi.registerCommand("plan", {
      description: "Create or discuss the Ralph execution plan for the active specification",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /plan");
        await ctx.waitForIdle();
        ensureNoBlocked(ctx);
        const specification = inspectSpecification({ cwd: ctx.cwd });
        assertState(specification.state, "specification");
        if (specification.state !== "existing") {
          ctx.ui.notify("Ralph planning requires an active specification at .ralph/plans/SPECIFICATION.md.", "warning");
          return;
        }
        const plan = inspectPlan({ cwd: ctx.cwd });
        assertState(plan.state, "execution plan");
        const phase = getPhase(ctx);
        if (phase === "planning" && plan.state === "existing") {
          const skill = loadPlan({ cwd: ctx.cwd });
          const mode = "planning-existing";
          pi.sendMessage({
            customType: PLANNING_MESSAGE_TYPE,
            content: formatPlanningInjection(skill, mode),
            display: false,
            details: { source: "prime-ralph", protocolVersion: PLANNING_PROTOCOL_VERSION, requestId: createRequestId(), command: "plan", mode, specificationState: "existing", planState: "existing", workflowPhase: "planning", sessionId: sessionId(ctx) },
          }, { triggerTurn: true, deliverAs: "followUp" });
          setPhase(ctx, "planning");
          return;
        }
        await resetRuntime.requestBoundary({
          ctx,
          command: "plan",
          resolveInjection: ({ ctx: boundaryCtx }) => {
            ensureNoBlocked(boundaryCtx);
            const currentSpec = inspectSpecification({ cwd: boundaryCtx.cwd });
            assertState(currentSpec.state, "specification");
            if (currentSpec.state !== "existing") throw new Error("Ralph planning requires an active specification at .ralph/plans/SPECIFICATION.md");
            const currentPlan = inspectPlan({ cwd: boundaryCtx.cwd });
            assertState(currentPlan.state, "execution plan");
            const prepare = loadPrepare({ cwd: boundaryCtx.cwd });
            const skill = loadPlan({ cwd: boundaryCtx.cwd });
            const mode = currentPlan.state === "existing" ? "planning-existing" : "planning-new";
            return {
              content: `${formatPrepareInjection(prepare)}
${formatPlanningInjection(skill, mode)}`,
              details: { workflowPhase: "planning", invocationMode: mode, planState: currentPlan.state, sessionId: sessionId(boundaryCtx) },
            };
          },
          onAdmitted: () => setPhase(ctx, "planning"),
        });
      },
    });

    pi.on("session_start", (event, ctx) => {
      const id = sessionId(ctx);
      const recovered = latestSessionPhase(ctx.sessionManager.getBranch(), id);
      if (recovered) sessionPhases.set(id, recovered);
      if (event.reason === "reload") return;
      let specification;
      try { ensureNoBlocked(ctx); specification = inspectSpecification({ cwd: ctx.cwd }); assertState(specification.state, "specification"); }
      catch (error) { ctx.ui.notify(`Ralph startup was not delivered: ${error.message}`, "error"); return; }
      const phase = recovered ?? (specification.state === "existing" ? "planning" : "specification");
      sessionPhases.set(id, phase);
      if (startupSessions.has(id) || hasStartupPrepareBoundary(ctx.sessionManager.getBranch(), id) || hasPlanningStartupBoundary(ctx.sessionManager.getBranch(), id)) return;
      try {
        const prepare = loadPrepare({ cwd: ctx.cwd });
        let message;
        if (phase === "specification") {
          message = {
            customType: STARTUP_PREPARE_MESSAGE_TYPE,
            content: formatPrepareInjection(prepare),
            display: false,
            details: { source: "prime-ralph", protocolVersion: SPECIFICATION_PROTOCOL_VERSION, requestId: createRequestId(), sessionId: id, mode: "specification-new", workflowPhase: "specification" },
          };
        } else {
          const plan = inspectPlan({ cwd: ctx.cwd });
          assertState(plan.state, "execution plan");
          const skill = loadPlan({ cwd: ctx.cwd });
          const mode = plan.state === "existing" ? "planning-existing" : "planning-new";
          message = {
            customType: PLANNING_STARTUP_MESSAGE_TYPE,
            content: `${formatPrepareInjection(prepare)}
${formatPlanningInjection(skill, mode)}`,
            display: false,
            details: { source: "prime-ralph", protocolVersion: PLANNING_PROTOCOL_VERSION, requestId: createRequestId(), sessionId: id, mode, planState: plan.state, workflowPhase: "planning" },
          };
        }
        pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
        startupSessions.add(id);
      } catch (error) {
        ctx.ui.notify(`Ralph ${phase} startup was not delivered: ${error.message}`, "error");
      }
    });
  };
}

export default createWorkflowExtension();
