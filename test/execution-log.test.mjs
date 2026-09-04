import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EXECUTION_LOG_RELATIVE_PATH, ExecutionLogError, appendExecutionLogEntry,
} from "../src/execution-log.js";

function project() {
  const cwd = mkdtempSync(join(tmpdir(), "prime-ralph-log-"));
  mkdirSync(join(cwd, ".ralph/logs"), { recursive: true });
  return cwd;
}
function occurrences(text, token) { return text.split(token).length - 1; }
function entry(cwd, overrides = {}) {
  return appendExecutionLogEntry({
    cwd, sessionId: "session-1", phase: "execute", cycle: 1,
    finalAssistantMessage: "Implemented the task.\nAll focused tests pass.",
    timestamp: "2026-04-05T06:07:08Z", ...overrides,
  });
}

test("creates the fixed human-readable log with one session header and complete entry fields", () => {
  const cwd = project(); const result = entry(cwd);
  assert.equal(result.written, true); assert.equal(result.path, join(cwd, EXECUTION_LOG_RELATIVE_PATH));
  const text = readFileSync(result.path, "utf8");
  assert.match(text, /^# Ralph execution log/);
  assert.match(text, /## Session session-1/);
  assert.match(text, /2026-04-05T06:07:08.000Z \| phase=execute \| cycle=1/);
  assert.match(text, /Final assistant message:\n\n> Implemented the task\.\n> All focused tests pass\./);
});

test("appends later cycles while emitting a session header exactly once", () => {
  const cwd = project(); entry(cwd); entry(cwd, { cycle: 2, finalAssistantMessage: "Second cycle." });
  const text = readFileSync(join(cwd, EXECUTION_LOG_RELATIVE_PATH), "utf8");
  assert.equal(occurrences(text, "## Session session-1"), 1);
  assert.equal(occurrences(text, "Final assistant message:"), 2);
  assert.ok(text.indexOf("cycle=1") < text.indexOf("cycle=2"));
});

test("adds one distinct header for each session in the same append-only log", () => {
  const cwd = project(); entry(cwd); entry(cwd, { sessionId: "session-2", cycle: 0, finalAssistantMessage: "New session." });
  const text = readFileSync(join(cwd, EXECUTION_LOG_RELATIVE_PATH), "utf8");
  assert.equal(occurrences(text, "## Session session-1"), 1);
  assert.equal(occurrences(text, "## Session session-2"), 1);
});

test("deduplicates the same semantic entry even if its timestamp changes", () => {
  const cwd = project(); const first = entry(cwd);
  const before = readFileSync(first.path, "utf8");
  const duplicate = entry(cwd, { timestamp: "2027-01-01T00:00:00Z" });
  assert.deepEqual({ written: duplicate.written, reason: duplicate.reason, identity: duplicate.identity }, { written: false, reason: "duplicate", identity: first.identity });
  assert.equal(readFileSync(first.path, "utf8"), before);
});

test("same message in a different cycle is a distinct entry", () => {
  const cwd = project(); const first = entry(cwd); const second = entry(cwd, { cycle: 2 });
  assert.equal(second.written, true); assert.notEqual(first.identity, second.identity);
});

test("waiting transitions never create or append to a log", () => {
  const cwd = project();
  const absent = entry(cwd, { phase: "waiting" });
  assert.deepEqual({ written: absent.written, reason: absent.reason }, { written: false, reason: "waiting" });
  assert.equal(existsSync(join(cwd, EXECUTION_LOG_RELATIVE_PATH)), false);
  entry(cwd); const before = readFileSync(join(cwd, EXECUTION_LOG_RELATIVE_PATH), "utf8");
  entry(cwd, { phase: "waiting", cycle: 2, finalAssistantMessage: "still waiting" });
  assert.equal(readFileSync(join(cwd, EXECUTION_LOG_RELATIVE_PATH), "utf8"), before);
});

test("waiting is a no-op even when the log parent is unavailable", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prime-ralph-waiting-"));
  assert.equal(entry(cwd, { phase: "waiting" }).reason, "waiting");
});

test("preserves existing regular-file bytes and appends after them", () => {
  const cwd = project(); const path = join(cwd, EXECUTION_LOG_RELATIVE_PATH); writeFileSync(path, "operator preface\n");
  entry(cwd); const text = readFileSync(path, "utf8");
  assert.ok(text.startsWith("operator preface\n")); assert.match(text, /## Session session-1/);
});

test("rejects a symlink log without modifying its target", () => {
  const cwd = project(); const outside = join(cwd, "outside.log"); writeFileSync(outside, "private\n");
  symlinkSync(outside, join(cwd, EXECUTION_LOG_RELATIVE_PATH));
  assert.throws(() => entry(cwd), /execution log must not be a symlink/);
  assert.equal(readFileSync(outside, "utf8"), "private\n");
});

test("rejects non-regular log path types", () => {
  const cwd = project(); mkdirSync(join(cwd, EXECUTION_LOG_RELATIVE_PATH));
  assert.throws(() => entry(cwd), /execution log is not a regular file/);
});

test("creates a missing logs directory only beneath a real .ralph directory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prime-ralph-log-parent-")); mkdirSync(join(cwd, ".ralph"));
  const result = entry(cwd);
  assert.equal(result.written, true);
  assert.equal(lstatSync(join(cwd, ".ralph/logs")).isDirectory(), true);
  assert.match(readFileSync(result.path, "utf8"), /## Session session-1/);
});

test("rejects a symlink installed by a racing logs-directory creator", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prime-ralph-log-race-")); mkdirSync(join(cwd, ".ralph"));
  const outside = project();
  const mkdir = (path) => { symlinkSync(join(outside, ".ralph/logs"), path, "dir"); const error = new Error("exists"); error.code = "EEXIST"; throw error; };
  assert.throws(() => entry(cwd, { mkdir }), /execution log parent must not be a symlink: \.ralph\/logs/);
  assert.equal(existsSync(join(outside, EXECUTION_LOG_RELATIVE_PATH)), false);
});

test("rejects symlink and non-directory .ralph parents, and a missing .ralph root", () => {
  const outside = project();
  const linked = mkdtempSync(join(tmpdir(), "prime-ralph-log-linked-")); symlinkSync(join(outside, ".ralph"), join(linked, ".ralph"), "dir");
  assert.throws(() => entry(linked), /execution log parent must not be a symlink: \.ralph/);
  const conflict = mkdtempSync(join(tmpdir(), "prime-ralph-log-conflict-")); writeFileSync(join(conflict, ".ralph"), "file");
  assert.throws(() => entry(conflict), /execution log parent is not a directory: \.ralph/);
  const missing = mkdtempSync(join(tmpdir(), "prime-ralph-log-missing-"));
  assert.throws(() => entry(missing), /execution log parent is absent: \.ralph/);
});

test("write and append errors are wrapped with the fixed path", () => {
  const fresh = project();
  assert.throws(() => entry(fresh, { writeFile: () => { throw new Error("disk full"); } }), (error) => {
    assert.ok(error instanceof ExecutionLogError); assert.match(error.message, /cannot append execution log: \.ralph\/logs\/EXECUTION_LOG\.md/); assert.match(error.cause.message, /disk full/); return true;
  });
  const existing = project(); entry(existing);
  assert.throws(() => entry(existing, { cycle: 2, appendFile: () => { throw new Error("read only"); } }), /cannot append execution log/);
});

test("invalid metadata and messages are rejected", () => {
  const cwd = project();
  for (const overrides of [
    { sessionId: "" }, { sessionId: "bad\nid" }, { phase: "" }, { phase: "bad\nphase" },
    { cycle: -1 }, { cycle: 1.5 }, { finalAssistantMessage: "  " }, { timestamp: "not-a-date" },
  ]) assert.throws(() => entry(cwd, overrides), TypeError);
  assert.equal(existsSync(join(cwd, EXECUTION_LOG_RELATIVE_PATH)), false);
});

test("session markers cannot collide through visually similar identifiers", () => {
  const cwd = project(); entry(cwd, { sessionId: "a:b" }); entry(cwd, { sessionId: "a_b", cycle: 2 });
  const text = readFileSync(join(cwd, EXECUTION_LOG_RELATIVE_PATH), "utf8");
  assert.equal(occurrences(text, "## Session a:b"), 1); assert.equal(occurrences(text, "## Session a_b"), 1);
});


test("starts a new contiguous section when sessions interleave", () => {
  const cwd = project(); entry(cwd); entry(cwd, { sessionId: "session-2", cycle: 1, finalAssistantMessage: "second" }); entry(cwd, { sessionId: "session-1", cycle: 2, finalAssistantMessage: "resumed" });
  const text = readFileSync(join(cwd, EXECUTION_LOG_RELATIVE_PATH), "utf8");
  assert.equal(occurrences(text, "## Session session-1"), 2); assert.equal(occurrences(text, "## Session session-2"), 1);
});
