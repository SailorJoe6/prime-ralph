import { lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { PrepareSkillError, validateCanonicalSkill } from "./reset-skill.js";

export const ACTIVE_SPECIFICATION_RELATIVE_PATH = ".ralph/plans/SPECIFICATION.md";
export const SPEC_IT_OUT_SKILL_RELATIVE_PATH = ".ralph/skills/spec-it-out/SKILL.md";
export const SPECIFICATION_PROTOCOL_VERSION = 1;
export const SPECIFICATION_INVOCATION_MODES = Object.freeze([
  "specification-new",
  "specification-existing",
  "specification-reset-existing",
]);
export const SPECIFICATION_MESSAGE_TYPE = "prime_ralph_specification_skill";
export const STARTUP_PREPARE_MESSAGE_TYPE = "prime_ralph_startup_prepare";
export const MAX_SPEC_IT_OUT_SKILL_BYTES = 128 * 1024;

export class SpecificationStateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SpecificationStateError";
  }
}

function missing(error) { return error?.code === "ENOENT"; }
function inspect(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (missing(error)) return undefined;
    throw new SpecificationStateError(`cannot inspect active specification path: ${ACTIVE_SPECIFICATION_RELATIVE_PATH}`, { cause: error });
  }
}

/** Inspect the exact active path without traversing project-control symlinks. */
export function inspectActiveSpecification({ cwd = process.cwd() } = {}) {
  const root = resolve(cwd);
  const ralph = resolve(root, ".ralph");
  const plans = resolve(root, ".ralph/plans");
  const path = resolve(root, ACTIVE_SPECIFICATION_RELATIVE_PATH);
  for (const [candidate, label] of [[ralph, ".ralph"], [plans, ".ralph/plans"]]) {
    const stat = inspect(candidate);
    if (!stat) return { state: "absent", path, relativePath: ACTIVE_SPECIFICATION_RELATIVE_PATH };
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SpecificationStateError(`active specification parent is not a real directory: ${label}`);
    }
  }
  const stat = inspect(path);
  if (!stat) return { state: "absent", path, relativePath: ACTIVE_SPECIFICATION_RELATIVE_PATH };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SpecificationStateError(`active specification is not a regular file: ${ACTIVE_SPECIFICATION_RELATIVE_PATH}`);
  }
  return { state: "existing", path, relativePath: ACTIVE_SPECIFICATION_RELATIVE_PATH };
}

export function loadSpecItOutSkill({ cwd = process.cwd(), maxBytes = MAX_SPEC_IT_OUT_SKILL_BYTES } = {}) {
  const path = resolve(cwd, SPEC_IT_OUT_SKILL_RELATIVE_PATH);
  let stat;
  try { stat = statSync(path); }
  catch (error) { throw new PrepareSkillError(`spec-it-out skill is unavailable at ${SPEC_IT_OUT_SKILL_RELATIVE_PATH}`, { cause: error }); }
  if (!stat.isFile()) throw new PrepareSkillError(`spec-it-out skill is not a file: ${SPEC_IT_OUT_SKILL_RELATIVE_PATH}`);
  if (stat.size === 0) throw new PrepareSkillError("spec-it-out skill is empty");
  if (stat.size > maxBytes) throw new PrepareSkillError(`spec-it-out skill exceeds ${maxBytes} bytes`);
  let text;
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > maxBytes) throw new PrepareSkillError(`spec-it-out skill exceeds ${maxBytes} bytes`);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof PrepareSkillError) throw error;
    throw new PrepareSkillError("spec-it-out skill is unreadable or not valid UTF-8", { cause: error });
  }
  validateCanonicalSkill(text, "spec-it-out");
  const normalized = text.replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  const metadata = parseDocument(frontmatter[1], { uniqueKeys: true, prettyErrors: false }).toJS();
  if (metadata?.["prime-ralph-invocation-version"] !== SPECIFICATION_PROTOCOL_VERSION) {
    throw new PrepareSkillError(`spec-it-out skill must declare prime-ralph-invocation-version: ${SPECIFICATION_PROTOCOL_VERSION}; merge the current canonical invocation contract into ${SPEC_IT_OUT_SKILL_RELATIVE_PATH}`);
  }
  return { path, text };
}

function attribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function specificationInvocation(mode) {
  if (!SPECIFICATION_INVOCATION_MODES.includes(mode)) throw new TypeError(`unknown specification invocation mode: ${mode}`);
  const specificationState = mode === "specification-new" ? "absent" : "existing";
  return Object.freeze({ protocolVersion: SPECIFICATION_PROTOCOL_VERSION, specificationState, invocationMode: mode });
}

export function formatSpecificationInjection({ path, text }, mode) {
  const metadata = JSON.stringify(specificationInvocation(mode));
  if (Buffer.byteLength(metadata) > 512) throw new TypeError("specification invocation metadata exceeds 512 bytes");
  return `<prime-ralph-invocation>${metadata}</prime-ralph-invocation>
<skill name="spec-it-out" location="${attribute(path)}">
${text}
</skill>`;
}

export function hasStartupPrepareBoundary(entries, sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return false;
  return Array.isArray(entries) && entries.some((entry) => entry?.type === "custom_message" &&
    entry.customType === STARTUP_PREPARE_MESSAGE_TYPE && entry.details?.source === "prime-ralph" &&
    entry.details?.protocolVersion === SPECIFICATION_PROTOCOL_VERSION && entry.details?.sessionId === sessionId);
}
