const transitions = {
  idle: ["preparing"], preparing: ["executing", "error"], executing: ["checkpointing", "error", "blocked", "complete"],
  checkpointing: ["compacting", "error"], compacting: ["rehydrating", "error"], rehydrating: ["executing", "complete", "blocked", "error"],
  blocked: [], complete: [], error: ["preparing"],
};

export class RalphCycleCoordinator {
  constructor({ appendMarker = () => {}, activeGoal = () => true } = {}) {
    this.appendMarker = appendMarker;
    this.activeGoal = activeGoal;
    this.state = "idle";
    this.cycleId = 0;
    this.compactedBoundary = null;
    this.continuationQueued = false;
  }

  transition(next, details = {}) {
    if (!transitions[this.state]?.includes(next)) throw new Error(`invalid Ralph cycle transition: ${this.state} -> ${next}`);
    this.state = next;
    this.appendMarker({ kind: "cycle_state", cycleId: this.cycleId, state: next, details: sanitize(details) });
    return this.snapshot();
  }
  begin() { this.cycleId += 1; this.compactedBoundary = null; this.continuationQueued = false; this.transition("preparing"); return this.snapshot(); }
  executing(details) { return this.transition("executing", details); }
  checkpoint(details) { return this.transition("checkpointing", details); }
  compacting(boundaryId) { this.compactedBoundary = boundaryId; return this.transition("compacting", { boundaryId }); }
  compacted({ boundaryId = this.compactedBoundary, activeGoal = this.activeGoal() } = {}) {
    if (boundaryId !== this.compactedBoundary) throw new Error("compaction boundary does not match the active cycle");
    this.transition("rehydrating", { boundaryId });
    this.continuationQueued = Boolean(activeGoal);
    if (this.continuationQueued) this.appendMarker({ kind: "goal_continuation", cycleId: this.cycleId, customType: "goal_context", boundaryId });
    return this.snapshot();
  }
  resumed() { this.continuationQueued = false; return this.transition("executing"); }
  acceptContinuation({ cycleId = this.cycleId, boundaryId = this.compactedBoundary } = {}) {
    if (cycleId !== this.cycleId || boundaryId !== this.compactedBoundary || !this.continuationQueued || this.state !== "rehydrating") {
      throw new Error("stale or duplicate Ralph continuation");
    }
    return this.resumed();
  }
  fail(error) { if (this.state === "error") return this.snapshot(); return this.transition("error", { error: String(error?.message ?? error).slice(0, 240) }); }
  block(reason) { return this.transition("blocked", { reason }); }
  complete(details) { return this.transition("complete", details); }
  recover(reason = "incomplete cycle after restart") {
    if (!["preparing", "executing", "checkpointing", "compacting", "rehydrating"].includes(this.state)) return this.snapshot();
    return this.transition("error", { recovery: reason });
  }
  snapshot() { return { state: this.state, cycleId: this.cycleId, compactedBoundary: this.compactedBoundary, continuationQueued: this.continuationQueued }; }
}

function sanitize(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return value.replace(/([A-Za-z0-9_-]*(?:token|secret|password|api[-_]?key))\s*[=:]\s*\S+/gi, "$1=[redacted]").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[redacted-email]").slice(0, 240);
  if (typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|password|api[-_]?key/i.test(key)).map(([key, val]) => [key, sanitize(val)]));
}
