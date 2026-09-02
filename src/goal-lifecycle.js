const TERMINAL = new Set(["complete", "blocked", "error", "budget_limit", "paused"]);
export class GoalLifecycle {
  constructor({ beads, issueId, sessionId, cycleId } = {}) { this.beads = beads; this.issueId = issueId; this.sessionId = sessionId; this.cycleId = cycleId; this.status = "active"; this.heartbeatAt = null; }
  startHeartbeat({ intervalMs = 60_000, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    if (this._heartbeatTimer) return false;
    this._clearHeartbeat = clearIntervalFn;
    this._heartbeatTimer = setIntervalFn(() => { try { this.heartbeat(); } catch (error) { this.status = "error"; this.lastError = String(error.message).slice(0, 200); } }, intervalMs);
    return true;
  }
  stopHeartbeat(clearIntervalFn = this._clearHeartbeat ?? clearInterval) { if (!this._heartbeatTimer) return false; clearIntervalFn(this._heartbeatTimer); this._heartbeatTimer = null; return true; }
  heartbeat() { if (TERMINAL.has(this.status)) return false; const issue = this.beads.issues?.get(this.issueId); if (!issue?.lease || issue.lease.sessionId !== this.sessionId) throw new Error("goal lease is not owned"); issue.lease.expiresAt = this.beads.now() + this.beads.leaseMs; this.heartbeatAt = this.beads.now(); return true; }
  transition(status, details = {}) { if (!new Set(["active", "paused", "complete", "blocked", "error", "budget_limit"]).has(status)) throw new Error("unknown goal status"); this.status = status; if (TERMINAL.has(status)) { this.stopHeartbeat(); try { this.beads.release(this.issueId, this.sessionId); } catch { /* lease may already be stale; terminal state still recorded */ } } return { status, issueId: this.issueId, cycleId: this.cycleId, details: sanitize(details) }; }
}
function sanitize(value) { if (typeof value === "string") return value.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[redacted-email]").slice(0, 300); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value).filter(([k]) => !/token|secret|password|api[-_]?key/i.test(k)).map(([k,v]) => [k,sanitize(v)])); }
