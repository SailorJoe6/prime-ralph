import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { PrepareSkillError, validateCanonicalSkill } from "./reset-skill.js";

export const EXECUTION_PROTOCOL_VERSION = 1;
export const EXECUTION_STATE_ENTRY_TYPE = "prime_ralph_execution_state";
export const EXECUTION_MESSAGE_TYPE = "prime_ralph_execution_skill";
export const BLOCKED_MESSAGE_TYPE = "prime_ralph_blocked_skill";
export const EXECUTE_SKILL_RELATIVE_PATH = ".ralph/skills/execute/SKILL.md";
export const BLOCKED_SKILL_RELATIVE_PATH = ".ralph/skills/blocked/SKILL.md";
export const MAX_EXECUTION_SKILL_BYTES = 128 * 1024;
export const RESTORED_BLOCKED_GUIDANCE = "The specification and execution plan were moved back to their active folder outside Ralph's normal unblock step. Ralph must verify that they are the same files and that the original blocker is resolved before execution can restart. Inspect the recorded blocker and unblock condition. If the condition is satisfied, call ralph_lifecycle confirm-forward; Ralph will verify the files and finish the recovery. Do not move the files again and do not call unblock.";
export const EXECUTION_MODES = Object.freeze(["execution-start", "execution-continue", "execution-resume", "execution-reset-running", "execution-reset-paused"]);
export const BLOCKED_MODES = Object.freeze(["blocked-start", "blocked-reset", "blocked-restored"]);
export const EXECUTION_STATUSES = Object.freeze(["inactive", "running", "waiting", "paused"]);

function loadSkill({ cwd, name, relativePath, maxBytes = MAX_EXECUTION_SKILL_BYTES }) {
  const path = resolve(cwd, relativePath);
  let stat;
  try { stat = statSync(path); }
  catch (error) { throw new PrepareSkillError(`${name} skill is unavailable at ${relativePath}`, { cause: error }); }
  if (!stat.isFile()) throw new PrepareSkillError(`${name} skill is not a file: ${relativePath}`);
  if (stat.size === 0) throw new PrepareSkillError(`${name} skill is empty`);
  if (stat.size > maxBytes) throw new PrepareSkillError(`${name} skill exceeds ${maxBytes} bytes`);
  let text;
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > maxBytes) throw new PrepareSkillError(`${name} skill exceeds ${maxBytes} bytes`);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof PrepareSkillError) throw error;
    throw new PrepareSkillError(`${name} skill is unreadable or not valid UTF-8`, { cause: error });
  }
  validateCanonicalSkill(text, name);
  const normalized = text.replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  const metadata = parseDocument(frontmatter[1], { uniqueKeys: true, prettyErrors: false }).toJS();
  if (metadata?.["prime-ralph-invocation-version"] !== EXECUTION_PROTOCOL_VERSION) {
    throw new PrepareSkillError(`${name} skill must declare prime-ralph-invocation-version: ${EXECUTION_PROTOCOL_VERSION}; merge the current canonical invocation contract into ${relativePath}`);
  }
  return { path, text };
}

export function loadExecuteSkill({ cwd = process.cwd(), maxBytes } = {}) {
  return loadSkill({ cwd, maxBytes, name: "execute", relativePath: EXECUTE_SKILL_RELATIVE_PATH });
}
export function loadBlockedSkill({ cwd = process.cwd(), maxBytes } = {}) {
  return loadSkill({ cwd, maxBytes, name: "blocked", relativePath: BLOCKED_SKILL_RELATIVE_PATH });
}

function attribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function format(skill, metadata) {
  const encoded = JSON.stringify(metadata);
  if (Buffer.byteLength(encoded) > 2048) throw new TypeError("Ralph lifecycle invocation metadata exceeds 2048 bytes");
  return `<prime-ralph-invocation>${encoded}</prime-ralph-invocation>\n<skill name="${attribute(metadata.skill)}" location="${attribute(skill.path)}">\n${skill.text}\n</skill>`;
}

export function formatExecutionInjection(skill, { mode, lifecycleId, cycle, status = "running", driverGoalId = null, resetRequested = false }) {
  if (!EXECUTION_MODES.includes(mode)) throw new TypeError(`unknown execution invocation mode: ${mode}`);
  if (typeof lifecycleId !== "string" || !lifecycleId || !Number.isInteger(cycle) || cycle < 1) throw new TypeError("valid lifecycleId and cycle are required");
  return format(skill, { protocolVersion: EXECUTION_PROTOCOL_VERSION, skill: "execute", invocationMode: mode, lifecycleId, cycle, lifecycleState: status, driver: "prime-agent-goal", driverGoalId, resetRequested });
}
export function formatBlockedInjection(skill, { mode, provenanceId }) {
  if (!BLOCKED_MODES.includes(mode)) throw new TypeError(`unknown blocked invocation mode: ${mode}`);
  if (typeof provenanceId !== "string" || !provenanceId) throw new TypeError("blocked provenanceId is required");
  return format(skill, { protocolVersion: EXECUTION_PROTOCOL_VERSION, skill: "blocked", invocationMode: mode, lifecycleState: "inactive", workflowPhase: mode === "blocked-restored" ? "planning" : "blocked", provenanceId, ...(mode === "blocked-restored" ? { recovery: "active-pair-restored" } : {}) });
}

export function inactiveExecutionState(sessionId) {
  return Object.freeze({ protocolVersion: EXECUTION_PROTOCOL_VERSION, source: "prime-ralph", sessionId, transition: 0, phase: "planning", status: "inactive", lifecycleId: null, cycle: 0, driverGoalId: null, pendingDecision: null, wait: null, provenanceId: null, forwardConfirmed: false });
}

export function latestGoalState(entries) {
  if (!Array.isArray(entries)) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === "thread_goal_state" && entry.data && typeof entry.data === "object") return entry.data;
  }
  return null;
}

function validLifecycleState(value, sessionId) {
  if (!(value && value.source === "prime-ralph" && value.protocolVersion === EXECUTION_PROTOCOL_VERSION && value.sessionId === sessionId &&
    EXECUTION_STATUSES.includes(value.status) && ["planning", "execution", "blocked"].includes(value.phase) && Number.isInteger(value.transition) && value.transition >= 0 &&
    Number.isInteger(value.cycle) && value.cycle >= 0)) return false;
  const validPhaseStatus = (value.phase === "planning" && value.status === "inactive") ||
    (value.phase === "execution" && ["running", "waiting", "paused"].includes(value.status)) ||
    (value.phase === "blocked" && value.status === "inactive");
  if (!validPhaseStatus) return false;
  if (value.status !== "inactive" && (typeof value.lifecycleId !== "string" || !value.lifecycleId || value.cycle < 1)) return false;
  if (value.status === "waiting" && (!value.wait || typeof value.wait.id !== "string" || !value.wait.id)) return false;
  if (value.status !== "waiting" && value.wait != null) return false;
  if (value.phase === "blocked" && (typeof value.provenanceId !== "string" || !value.provenanceId)) return false;
  return true;
}
export class ExecutionStateRecoveryError extends Error {
  constructor(message) { super(message); this.name = "ExecutionStateRecoveryError"; }
}

export function latestExecutionState(entries, sessionId) {
  if (!Array.isArray(entries)) return inactiveExecutionState(sessionId);
  let latest = null;
  for (const entry of entries) {
    if (entry?.type !== "custom" || entry.customType !== EXECUTION_STATE_ENTRY_TYPE) continue;
    const data = entry.data;
    if (data?.sessionId !== sessionId) continue;
    if (!validLifecycleState(data, sessionId)) {
      throw new ExecutionStateRecoveryError("Ralph lifecycle recovery stopped at an invalid state record; preserve the session and inspect bounded diagnostics before retrying");
    }
    if (latest && data.transition <= latest.transition) {
      throw new ExecutionStateRecoveryError("Ralph lifecycle recovery stopped at a stale or duplicate state record; preserve the session and inspect bounded diagnostics before retrying");
    }
    latest = data;
  }
  return latest ? Object.freeze({ ...latest }) : inactiveExecutionState(sessionId);
}

export function nextExecutionState(current, patch) {
  const next = { ...current, ...patch, transition: current.transition + 1 };
  if (next.status === "waiting" && (!next.wait || typeof next.wait.id !== "string" || !next.wait.id)) throw new TypeError("waiting lifecycle requires a wait record");
  if (next.status !== "waiting" && next.wait != null) throw new TypeError("only a waiting lifecycle may retain a wait record");
  if (!validLifecycleState(next, current.sessionId)) throw new TypeError("invalid Ralph execution state transition record");
  const from = `${current.phase}/${current.status}`, to = `${next.phase}/${next.status}`;
  const allowed = {
    "planning/inactive": new Set(["planning/inactive", "execution/running", "blocked/inactive"]),
    "execution/running": new Set(["execution/running", "execution/waiting", "execution/paused", "planning/inactive", "blocked/inactive"]),
    "execution/waiting": new Set(["execution/waiting", "execution/running", "execution/paused", "planning/inactive", "blocked/inactive"]),
    "execution/paused": new Set(["execution/paused", "execution/running", "planning/inactive"]),
    "blocked/inactive": new Set(["blocked/inactive", "planning/inactive"]),
  };
  if (!allowed[from]?.has(to)) throw new TypeError(`invalid Ralph lifecycle transition: ${from} -> ${to}`);
  const validPhaseStatus = (next.phase === "planning" && next.status === "inactive") ||
    (next.phase === "execution" && ["running", "waiting", "paused"].includes(next.status)) ||
    (next.phase === "blocked" && next.status === "inactive");
  if (!validPhaseStatus) throw new TypeError(`invalid Ralph phase/status combination: ${next.phase}/${next.status}`);
  if (next.status !== "inactive" && (typeof next.lifecycleId !== "string" || !next.lifecycleId || next.cycle < 1)) throw new TypeError("outstanding execution lifecycle requires identity and cycle");
  if (next.status === "waiting" && (!next.wait || typeof next.wait.id !== "string" || !next.wait.id)) throw new TypeError("waiting lifecycle requires a wait record");
  if (next.status !== "waiting" && next.wait != null) throw new TypeError("only a waiting lifecycle may retain a wait record");
  if (next.phase === "blocked" && (typeof next.provenanceId !== "string" || !next.provenanceId)) throw new TypeError("blocked phase requires current provenance");
  return Object.freeze(next);
}

export function beginExecution(current, { lifecycleId, driverGoalId = null }) {
  if (current.status !== "inactive" || current.phase === "blocked") throw new Error(`cannot start execution while Ralph lifecycle is ${current.status} in ${current.phase} phase`);
  return nextExecutionState(current, { phase: "execution", status: "running", lifecycleId, cycle: 1, driverGoalId, pendingDecision: null, wait: null, provenanceId: null, forwardConfirmed: false });
}

export function reconcileGoalState(current, goal) {
  if (!goal || current.status === "inactive") return current;
  if (goal.status === "idle" && current.driverGoalId) return nextExecutionState(current, { phase: "planning", status: "inactive", pendingDecision: null, wait: null, cancellation: "native goal cleared" });
  if (goal.status === "error") return nextExecutionState(current, { status: "paused", pendingDecision: null, wait: null, pausedWait: current.status === "waiting" ? current.wait : null, pauseReason: "native goal error" });
  if (current.driverGoalId && goal.goalId && current.driverGoalId !== goal.goalId && ["active", "paused", "budget_limited"].includes(goal.status)) {
    return nextExecutionState(current, { status: "paused", pendingDecision: null, pauseReason: "native goal identity changed" });
  }
  if (goal.status === "paused" || goal.status === "budget_limited") {
    if (current.status === "running") return nextExecutionState(current, { status: "paused", driverGoalId: goal.goalId ?? current.driverGoalId, pauseReason: `native goal ${goal.status}` });
    return current;
  }
  if (goal.status === "active" && current.status === "paused" && (!current.driverGoalId || current.driverGoalId === goal.goalId)) {
    return nextExecutionState(current, { status: "running", driverGoalId: goal.goalId, pauseReason: null, resumed: true });
  }
  return current;
}

export function executionContextProjection(messages, { allowedTypes = [EXECUTION_MESSAGE_TYPE, BLOCKED_MESSAGE_TYPE], lifecycleId, provenanceId } = {}) {
  if (!Array.isArray(messages)) return undefined;
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i], details = message?.details;
    if (message?.role !== "custom" || !allowedTypes.includes(message.customType) || details?.source !== "prime-ralph" || details?.protocolVersion !== EXECUTION_PROTOCOL_VERSION) continue;
    if (lifecycleId && details.lifecycleId !== lifecycleId) continue;
    if (provenanceId && details.provenanceId !== provenanceId) continue;
    index = i; break;
  }
  if (index < 0) return undefined;
  const boundary = messages[index];
  if (boundary.details?.preserveTrigger === true && index > 0) {
    const trigger = [...messages.slice(0, index)].reverse().find((message) => message?.role === "user");
    return trigger ? [boundary, trigger, ...messages.slice(index + 1)] : messages.slice(index);
  }
  return messages.slice(index);
}
