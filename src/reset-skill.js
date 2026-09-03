import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

export const PREPARE_SKILL_RELATIVE_PATH = ".ralph/skills/prepare/SKILL.md";
export const MAX_PREPARE_SKILL_BYTES = 128 * 1024;

export class PrepareSkillError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PrepareSkillError";
  }
}

export function loadPrepareSkill({ cwd = process.cwd(), maxBytes = MAX_PREPARE_SKILL_BYTES } = {}) {
  const path = resolve(cwd, PREPARE_SKILL_RELATIVE_PATH);
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    throw new PrepareSkillError(`prepare skill is unavailable at ${PREPARE_SKILL_RELATIVE_PATH}`, { cause: error });
  }
  if (!stat.isFile()) throw new PrepareSkillError(`prepare skill is not a file: ${PREPARE_SKILL_RELATIVE_PATH}`);
  if (stat.size === 0) throw new PrepareSkillError("prepare skill is empty");
  if (stat.size > maxBytes) throw new PrepareSkillError(`prepare skill exceeds ${maxBytes} bytes`);

  let text;
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > maxBytes) throw new PrepareSkillError(`prepare skill exceeds ${maxBytes} bytes`);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PrepareSkillError("prepare skill is unreadable or not valid UTF-8", { cause: error });
  }
  validatePrepareSkill(text);
  return { path, text };
}

export function validatePrepareSkill(text) {
  if (typeof text !== "string" || !text.trim()) throw new PrepareSkillError("prepare skill is empty");
  if (text.includes("\0")) throw new PrepareSkillError("prepare skill contains a NUL byte");
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) throw new PrepareSkillError("prepare skill must contain YAML frontmatter");
  let metadata;
  try {
    const document = parseDocument(match[1], { uniqueKeys: true, prettyErrors: false });
    if (document.errors.length) throw document.errors[0];
    metadata = document.toJS();
  } catch (error) {
    throw new PrepareSkillError("prepare skill frontmatter is invalid YAML", { cause: error });
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.name !== "prepare") {
    throw new PrepareSkillError('prepare skill frontmatter must declare name: prepare');
  }
  if (typeof metadata.description !== "string" || !metadata.description.trim()) {
    throw new PrepareSkillError("prepare skill frontmatter must contain a non-empty description");
  }
  if (!normalized.slice(match[0].length).trim()) throw new PrepareSkillError("prepare skill body is empty");
  return true;
}

export function formatPrepareInjection({ path, text }) {
  const safePath = String(path).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<skill name="prepare" location="${safePath}">\n${text}\n</skill>`;
}
