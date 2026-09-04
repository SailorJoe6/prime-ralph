import { lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { PrepareSkillError, validateCanonicalSkill } from "./reset-skill.js";

export const ACTIVE_PLAN_RELATIVE_PATH = ".ralph/plans/EXECUTION_PLAN.md";
export const BLOCKED_SPECIFICATION_RELATIVE_PATH = ".ralph/plans/blocked/SPECIFICATION.md";
export const BLOCKED_PLAN_RELATIVE_PATH = ".ralph/plans/blocked/EXECUTION_PLAN.md";
export const PLAN_SKILL_RELATIVE_PATH = ".ralph/skills/plan/SKILL.md";
export const PLANNING_PROTOCOL_VERSION = 1;
export const PLANNING_INVOCATION_MODES = Object.freeze([
  "planning-new",
  "planning-existing",
  "planning-reset-new",
  "planning-reset-existing",
]);
export const PLANNING_MESSAGE_TYPE = "prime_ralph_planning_skill";
export const PLANNING_STARTUP_MESSAGE_TYPE = "prime_ralph_planning_startup";
export const MAX_PLAN_SKILL_BYTES = 128 * 1024;

export class PlanningStateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PlanningStateError";
  }
}

function missing(error) { return error?.code === "ENOENT"; }
function inspect(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (missing(error)) return undefined;
    throw new PlanningStateError(`cannot inspect active execution plan path: ${ACTIVE_PLAN_RELATIVE_PATH}`, { cause: error });
  }
}

/** Inspect only the exact direct active-plan path without following control-path symlinks. */
export function inspectActivePlan({ cwd = process.cwd() } = {}) {
  const root = resolve(cwd);
  const path = resolve(root, ACTIVE_PLAN_RELATIVE_PATH);
  for (const [candidate, label] of [[resolve(root, ".ralph"), ".ralph"], [resolve(root, ".ralph/plans"), ".ralph/plans"]]) {
    const stat = inspect(candidate);
    if (!stat) return { state: "absent", path, relativePath: ACTIVE_PLAN_RELATIVE_PATH };
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PlanningStateError(`active execution plan parent is not a real directory: ${label}`);
  }
  const stat = inspect(path);
  if (!stat) return { state: "absent", path, relativePath: ACTIVE_PLAN_RELATIVE_PATH };
  if (stat.isSymbolicLink() || !stat.isFile()) throw new PlanningStateError(`active execution plan is not a regular file: ${ACTIVE_PLAN_RELATIVE_PATH}`);
  return { state: "existing", path, relativePath: ACTIVE_PLAN_RELATIVE_PATH };
}

export function inspectBlockedPlanningDocuments({ cwd = process.cwd() } = {}) {
  const root = resolve(cwd);
  const blocked = resolve(root, ".ralph/plans/blocked");
  for (const [candidate, label] of [[resolve(root, ".ralph"), ".ralph"], [resolve(root, ".ralph/plans"), ".ralph/plans"], [blocked, ".ralph/plans/blocked"]]) {
    const parent = inspect(candidate);
    if (!parent) return { state: "absent", paths: [] };
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new PlanningStateError(`blocked planning parent is not a real directory: ${label}`);
  }
  const paths = [];
  for (const relativePath of [BLOCKED_SPECIFICATION_RELATIVE_PATH, BLOCKED_PLAN_RELATIVE_PATH]) {
    const path = resolve(root, relativePath), stat = inspect(path);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new PlanningStateError(`blocked planning document is not a regular file: ${relativePath}`);
    paths.push(relativePath);
  }
  return { state: paths.length === 0 ? "absent" : paths.length === 2 ? "complete" : "partial", paths };
}

export function loadPlanSkill({ cwd = process.cwd(), maxBytes = MAX_PLAN_SKILL_BYTES } = {}) {
  const path = resolve(cwd, PLAN_SKILL_RELATIVE_PATH);
  let stat;
  try { stat = statSync(path); }
  catch (error) { throw new PrepareSkillError(`plan skill is unavailable at ${PLAN_SKILL_RELATIVE_PATH}`, { cause: error }); }
  if (!stat.isFile()) throw new PrepareSkillError(`plan skill is not a file: ${PLAN_SKILL_RELATIVE_PATH}`);
  if (stat.size === 0) throw new PrepareSkillError("plan skill is empty");
  if (stat.size > maxBytes) throw new PrepareSkillError(`plan skill exceeds ${maxBytes} bytes`);
  let text;
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > maxBytes) throw new PrepareSkillError(`plan skill exceeds ${maxBytes} bytes`);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof PrepareSkillError) throw error;
    throw new PrepareSkillError("plan skill is unreadable or not valid UTF-8", { cause: error });
  }
  validateCanonicalSkill(text, "plan");
  const normalized = text.replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  const metadata = parseDocument(frontmatter[1], { uniqueKeys: true, prettyErrors: false }).toJS();
  if (metadata?.["prime-ralph-invocation-version"] !== PLANNING_PROTOCOL_VERSION) {
    throw new PrepareSkillError(`plan skill must declare prime-ralph-invocation-version: ${PLANNING_PROTOCOL_VERSION}; merge the current canonical invocation contract into ${PLAN_SKILL_RELATIVE_PATH}`);
  }
  return { path, text };
}

function attribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function planningInvocation(mode) {
  if (!PLANNING_INVOCATION_MODES.includes(mode)) throw new TypeError(`unknown planning invocation mode: ${mode}`);
  const planState = mode.endsWith("existing") ? "existing" : "absent";
  return Object.freeze({ protocolVersion: PLANNING_PROTOCOL_VERSION, specificationState: "existing", planState, invocationMode: mode });
}

export function formatPlanningInjection({ path, text }, mode) {
  const metadata = JSON.stringify(planningInvocation(mode));
  if (Buffer.byteLength(metadata) > 512) throw new TypeError("planning invocation metadata exceeds 512 bytes");
  return `<prime-ralph-invocation>${metadata}</prime-ralph-invocation>
<skill name="plan" location="${attribute(path)}">
${text}
</skill>`;
}

export function hasPlanningStartupBoundary(entries, sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  return Array.isArray(entries) && entries.some((entry) => entry?.type === "custom_message" &&
    entry.customType === PLANNING_STARTUP_MESSAGE_TYPE && entry.details?.source === "prime-ralph" &&
    entry.details?.protocolVersion === PLANNING_PROTOCOL_VERSION && entry.details?.sessionId === sessionId);
}
