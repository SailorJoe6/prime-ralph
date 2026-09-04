import { randomUUID } from "node:crypto";
import { createResetExtension } from "./reset-extension.js";
import { formatPrepareInjection, loadPrepareSkill } from "./reset-skill.js";
import {
  formatSpecificationInjection,
  hasStartupPrepareBoundary,
  inspectActiveSpecification,
  loadSpecItOutSkill,
  SPECIFICATION_MESSAGE_TYPE,
  SPECIFICATION_PROTOCOL_VERSION,
  STARTUP_PREPARE_MESSAGE_TYPE,
} from "./specification.js";

export function createWorkflowExtension({
  loadPrepare = loadPrepareSkill,
  loadSpecItOut = loadSpecItOutSkill,
  inspectSpecification = inspectActiveSpecification,
  createRequestId = randomUUID,
} = {}) {
  return function workflowExtension(pi) {
    const startupSessions = new Set();
    createResetExtension({ loadPrepare, loadSpecItOut, inspectSpecification, createRequestId })(pi);

    pi.registerCommand("spec-it-out", {
      description: "Develop a new or existing Ralph specification in the current conversation",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /spec-it-out");
        await ctx.waitForIdle();
        const specification = inspectSpecification({ cwd: ctx.cwd });
        if (!new Set(["absent", "existing"]).has(specification.state)) throw new TypeError(`unsupported specification state: ${specification.state}`);
        const mode = specification.state === "existing" ? "specification-existing" : "specification-new";
        const skill = loadSpecItOut({ cwd: ctx.cwd });
        const message = {
          customType: SPECIFICATION_MESSAGE_TYPE,
          content: formatSpecificationInjection(skill, mode),
          display: false,
          details: {
            source: "prime-ralph",
            protocolVersion: SPECIFICATION_PROTOCOL_VERSION,
            requestId: createRequestId(),
            command: "spec-it-out",
            mode,
            specificationState: specification.state,
          },
        };
        pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      },
    });

    pi.on("session_start", (event, ctx) => {
      if (event.reason === "reload") return;
      let specification;
      try { specification = inspectSpecification({ cwd: ctx.cwd }); }
      catch (error) {
        ctx.ui.notify(`Ralph specification startup was not delivered: ${error.message}`, "error");
        return;
      }
      if (!new Set(["absent", "existing"]).has(specification.state)) {
        ctx.ui.notify(`Ralph specification startup was not delivered: unsupported specification state ${specification.state}`, "error");
        return;
      }
      if (specification.state === "existing") {
        ctx.ui.notify("Ralph found an active specification. Planning startup is not available in this release.", "info");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      if (startupSessions.has(sessionId) || hasStartupPrepareBoundary(ctx.sessionManager.getBranch(), sessionId)) return;
      let skill;
      try { skill = loadPrepare({ cwd: ctx.cwd }); }
      catch (error) {
        ctx.ui.notify(`Ralph specification startup was not delivered: ${error.message}`, "warning");
        return;
      }
      try {
        pi.sendMessage({
          customType: STARTUP_PREPARE_MESSAGE_TYPE,
          content: formatPrepareInjection(skill),
          display: false,
          details: {
            source: "prime-ralph",
            protocolVersion: SPECIFICATION_PROTOCOL_VERSION,
            requestId: createRequestId(),
            sessionId,
            mode: "specification-new",
          },
        }, { triggerTurn: true, deliverAs: "followUp" });
        startupSessions.add(sessionId);
      } catch (error) {
        ctx.ui.notify(`Ralph specification startup was not delivered: ${error.message}`, "error");
      }
    });
  };
}

export default createWorkflowExtension();
