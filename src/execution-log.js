import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Fixed, append-only, human-readable execution-log location. */
export const EXECUTION_LOG_RELATIVE_PATH = ".ralph/logs/EXECUTION_LOG.md";
export const EXECUTION_LOG_VERSION = 1;

export class ExecutionLogError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ExecutionLogError";
  }
}

function inspect(path, relativePath, lstat) {
  try { return lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new ExecutionLogError(`cannot inspect execution log path: ${relativePath}`, { cause: error });
  }
}

function requireRealDirectory(root, relativePath, lstat) {
  const stat = inspect(resolve(root, relativePath), relativePath, lstat);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new ExecutionLogError(`execution log parent must not be a symlink: ${relativePath}`);
  if (!stat.isDirectory()) throw new ExecutionLogError(`execution log parent is not a directory: ${relativePath}`);
  return true;
}

function ensureParent(root, lstat, mkdir) {
  if (!requireRealDirectory(root, ".ralph", lstat)) throw new ExecutionLogError("execution log parent is absent: .ralph");
  if (requireRealDirectory(root, ".ralph/logs", lstat)) return;
  try { mkdir(resolve(root, ".ralph/logs"), { mode: 0o700 }); }
  catch (error) {
    // A racing creator is accepted only after the same no-symlink/type validation.
    if (error?.code !== "EEXIST") throw new ExecutionLogError("cannot create execution log parent: .ralph/logs", { cause: error });
  }
  if (!requireRealDirectory(root, ".ralph/logs", lstat)) throw new ExecutionLogError("execution log parent is absent after creation: .ralph/logs");
}

function validateSingleLine(value, label) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) throw new TypeError(`${label} must be a non-empty single-line string`);
}

function encodedMarker(value) { return Buffer.from(value, "utf8").toString("base64url"); }
function quoted(text) { return text.split(/\r?\n/).map((line) => `> ${line}`).join("\n"); }

function normalizeTimestamp(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.valueOf())) throw new TypeError("timestamp must identify a valid date");
  return date.toISOString();
}

function formatSession(sessionId) {
  return `\n## Session ${sessionId}\n<!-- prime-ralph-session:${encodedMarker(sessionId)} -->\n`;
}

function entryIdentity({ sessionId, phase, cycle, finalAssistantMessage }) {
  return createHash("sha256").update(JSON.stringify({ sessionId, phase, cycle, finalAssistantMessage })).digest("hex");
}

function formatEntry({ timestamp, phase, cycle, finalAssistantMessage, identity }) {
  return `\n### ${timestamp} | phase=${phase} | cycle=${cycle}\n\nFinal assistant message:\n\n${quoted(finalAssistantMessage)}\n\n<!-- prime-ralph-entry:${identity} -->\n`;
}

/**
 * Append one terminal cycle message. Waiting transitions intentionally produce no log entry.
 * Duplicate session/phase/cycle/message events are ignored even when their timestamps differ.
 */
export function appendExecutionLogEntry({
  cwd = process.cwd(), sessionId, phase, cycle, finalAssistantMessage,
  timestamp = new Date(), lstat = lstatSync, readFile = readFileSync,
  mkdir = mkdirSync, writeFile = writeFileSync, appendFile = appendFileSync,
} = {}) {
  validateSingleLine(sessionId, "sessionId");
  validateSingleLine(phase, "phase");
  if (phase === "waiting") return Object.freeze({ written: false, reason: "waiting", path: resolve(cwd, EXECUTION_LOG_RELATIVE_PATH) });
  if (!Number.isSafeInteger(cycle) || cycle < 0) throw new TypeError("cycle must be a non-negative safe integer");
  if (typeof finalAssistantMessage !== "string" || !finalAssistantMessage.trim()) throw new TypeError("finalAssistantMessage must be a non-empty string");
  const isoTimestamp = normalizeTimestamp(timestamp);
  const root = resolve(cwd);
  ensureParent(root, lstat, mkdir);
  const path = resolve(root, EXECUTION_LOG_RELATIVE_PATH);
  const stat = inspect(path, EXECUTION_LOG_RELATIVE_PATH, lstat);
  if (stat?.isSymbolicLink()) throw new ExecutionLogError(`execution log must not be a symlink: ${EXECUTION_LOG_RELATIVE_PATH}`);
  if (stat && !stat.isFile()) throw new ExecutionLogError(`execution log is not a regular file: ${EXECUTION_LOG_RELATIVE_PATH}`);
  let existing = "";
  if (stat) {
    try { existing = readFile(path, "utf8"); }
    catch (error) { throw new ExecutionLogError(`execution log is unreadable: ${EXECUTION_LOG_RELATIVE_PATH}`, { cause: error }); }
  }
  const identity = entryIdentity({ sessionId, phase, cycle, finalAssistantMessage });
  if (existing.includes(`<!-- prime-ralph-entry:${identity} -->`)) {
    return Object.freeze({ written: false, reason: "duplicate", path, identity });
  }
  const sessionMarker = `<!-- prime-ralph-session:${encodedMarker(sessionId)} -->`;
  const header = existing ? "" : `# Ralph execution log\n<!-- prime-ralph-log:v${EXECUTION_LOG_VERSION} -->\n`;
  const priorMarkers = [...existing.matchAll(/<!-- prime-ralph-session:[A-Za-z0-9_-]+ -->/g)];
  const session = priorMarkers.at(-1)?.[0] === sessionMarker ? "" : formatSession(sessionId);
  const entry = formatEntry({ timestamp: isoTimestamp, phase, cycle, finalAssistantMessage, identity });
  const text = `${header}${session}${entry}`;
  try {
    if (stat) appendFile(path, text, { encoding: "utf8", flag: "a" });
    else writeFile(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new ExecutionLogError(`cannot append execution log: ${EXECUTION_LOG_RELATIVE_PATH}`, { cause: error });
  }
  return Object.freeze({ written: true, path, identity });
}
