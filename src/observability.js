/** Sanitized lifecycle event projection used by the research/POC tracer. */

const HOOKS = [
  "session_start", "session_before_compact", "session_compact",
  "turn_start", "turn_end", "message_start", "message_end",
  "agent_start", "agent_end", "context",
];

export const OBSERVABILITY_HOOKS = Object.freeze([...HOOKS]);

function messageShape(message) {
  if (!message || typeof message !== "object") return undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    role: typeof message.role === "string" ? message.role : undefined,
    customType: typeof message.customType === "string" ? message.customType : undefined,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    hasToolCall: content.some((part) => part && part.type === "toolCall"),
    contentBlockTypes: content.map((part) => part?.type).filter((type) => typeof type === "string"),
    toolName: typeof message.toolName === "string" ? message.toolName : undefined,
  };
}

function goalStateFromBranch(ctx) {
  const branch = ctx?.sessionManager?.getBranch?.() ?? [];
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === "thread_goal_state") {
      const state = entry.data;
      if (!state || typeof state !== "object") return undefined;
      return {
        status: typeof state.status === "string" ? state.status : undefined,
        active: typeof state.active === "boolean" ? state.active : undefined,
        goalId: typeof state.goalId === "string" ? state.goalId : undefined,
        continuationsUsed: Number.isSafeInteger(state.continuationsUsed) ? state.continuationsUsed : undefined,
      };
    }
  }
  return undefined;
}

export function sanitizeLifecycleEvent(type, event, ctx) {
  const result = { type, timestamp: Date.now() };
  if (event && typeof event === "object") {
    if (typeof event.turnIndex === "number") result.turnIndex = event.turnIndex;
    if (typeof event.fromExtension === "boolean") result.fromExtension = event.fromExtension;
    if (typeof event.customInstructions === "string") result.hasCustomInstructions = true;
    if (event.message) result.message = messageShape(event.message);
    if (Array.isArray(event.toolResults)) result.toolResultCount = event.toolResults.length;
    if (Array.isArray(event.messages)) {
      result.messageCount = event.messages.length;
      result.messageShapes = event.messages.slice(-3).map(messageShape);
    }
    if (Array.isArray(event.branchEntries)) result.branchEntryCount = event.branchEntries.length;
    if (event.preparation && typeof event.preparation === "object") {
      result.compaction = {
        firstKeptEntryIdPresent: typeof event.preparation.firstKeptEntryId === "string",
        tokensBefore: typeof event.preparation.tokensBefore === "number" ? event.preparation.tokensBefore : undefined,
        messagesToSummarize: Array.isArray(event.preparation.messagesToSummarize) ? event.preparation.messagesToSummarize.length : undefined,
      };
    }
    if (Array.isArray(event.messages)) {
      result.contextMessageRoles = event.messages.map((message) => message?.role).filter((role) => typeof role === "string");
    }
  }
  const goal = goalStateFromBranch(ctx);
  if (goal) result.goal = goal;
  return result;
}

export function createLifecycleTracer({ sink = console.log, now = Date.now } = {}) {
  const records = [];
  return {
    record(type, event, ctx) {
      const record = sanitizeLifecycleEvent(type, event, ctx);
      record.timestamp = now();
      records.push(record);
      sink(record);
      return record;
    },
    records,
  };
}
