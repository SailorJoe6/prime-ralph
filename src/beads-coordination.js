export class BeadsCoordinator {
  constructor({ leaseMs = 15 * 60_000, now = () => Date.now() } = {}) { this.leaseMs = leaseMs; this.now = now; this.issues = new Map(); }
  addIssue(issue) { this.issues.set(issue.id, { ...issue, status: issue.status ?? "open", lease: null, evidence: [] }); }
  selectNext({ sessionId } = {}) { return [...this.issues.values()].filter((i) => i.status === "open" && (!i.lease || this.isStale(i))).sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))[0] ?? null; }
  claim(issueId, sessionId) {
    const issue = this.issues.get(issueId); if (!issue) throw new Error("unknown issue");
    if (issue.lease && issue.lease.sessionId !== sessionId && !this.isStale(issue)) throw new Error("issue is already leased");
    issue.lease = { sessionId, claimedAt: this.now(), expiresAt: this.now() + this.leaseMs }; return { ...issue.lease };
  }
  isStale(issue) { return Boolean(issue.lease && issue.lease.expiresAt <= this.now()); }
  checkpoint(issueId, sessionId, evidence) { const issue = this.requireOwner(issueId, sessionId); issue.evidence.push(sanitize(evidence)); issue.lease.expiresAt = this.now() + this.leaseMs; return issue.evidence.at(-1); }
  close(issueId, sessionId, evidence) { if (evidence === undefined || evidence === null || evidence === "") throw new Error("durable evidence is required"); const issue = this.requireOwner(issueId, sessionId); this.checkpoint(issueId, sessionId, evidence); issue.status = "closed"; issue.lease = null; return { ...issue, evidence: [...issue.evidence] }; }
  release(issueId, sessionId) { const issue = this.requireOwner(issueId, sessionId); issue.lease = null; return true; }
  requireOwner(issueId, sessionId) { const issue = this.issues.get(issueId); if (!issue || !issue.lease || issue.lease.sessionId !== sessionId || this.isStale(issue)) throw new Error("lease is not owned or is stale"); return issue; }
}

export function runQualityGates(gates = [], context = {}) { const results = gates.map((gate) => { try { const passed = gate(context) === true; return { name: gate.name || "anonymous", passed }; } catch (error) { return { name: gate.name || "anonymous", passed: false, error: String(error.message).slice(0, 200) }; } }); return { passed: results.every((result) => result.passed), results }; }
function sanitize(value) { if (typeof value === "string") return value.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[redacted-email]").slice(0, 500); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|password|api[-_]?key/i.test(key)).map(([key, val]) => [key, sanitize(val)])); }
