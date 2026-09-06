import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResetExtension } from "../src/reset-extension.js";
import {
  RESET_MARKER_TYPE,
  RESET_MESSAGE_TYPE,
  RESET_PROTOCOL_VERSION,
  RESET_STATE_TYPE,
  resetCompactionInstructions,
} from "../src/reset-context.js";

function harness({ branch = [], persistSent = true, sendError, appendError, specificationState = "absent" } = {}) {
  const handlers = new Map(), commands = new Map(), sent = [], entries = [], notices = [], compactions = [];
  let nextEntry = branch.length;
  const pi = {
    registerCommand(name, value) { commands.set(name, value); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(customType, data) {
      if (appendError) throw appendError;
      const entry = { type: "custom", id: `e${++nextEntry}`, customType, data };
      entries.push(entry); branch.push(entry);
    },
    sendMessage(message, options) {
      if (sendError) throw sendError;
      sent.push({ message, options });
      if (persistSent) branch.push({ type: "custom_message", id: `e${++nextEntry}`, ...message });
    },
  };
  createResetExtension({
    loadPrepare: ({ cwd }) => ({ path: `${cwd}/.ralph/skills/prepare/SKILL.md`, text: "---\nname: prepare\ndescription: test\n---\nbody" }),
    loadSpecItOut: ({ cwd }) => ({ path: `${cwd}/.ralph/skills/spec-it-out/SKILL.md`, text: "---\nname: spec-it-out\ndescription: test\n---\nspec body" }),
    inspectSpecification: () => ({ state: specificationState, relativePath: ".ralph/plans/SPECIFICATION.md" }),
    createRequestId: (() => { let id = 0; return () => `r${++id}`; })(),
  })(pi);
  const ctx = {
    cwd: "/project",
    isIdle: () => true,
    hasPendingMessages: () => false,
    waitForIdle: async () => {},
    compact: (options) => compactions.push(options),
    abort: () => {},
    sessionManager: { getBranch: () => branch },
    ui: { notify: (...args) => notices.push(args) },
  };
  const beforeCompact = (customInstructions = resetCompactionInstructions("r1")) => handlers.get("session_before_compact")({
    customInstructions,
    preparation: { tokensBefore: 123 },
    branchEntries: branch,
    signal: new AbortController().signal,
  }, ctx);
  return { handlers, commands, sent, entries, branch, notices, compactions, ctx, beforeCompact };
}

async function request(h) { await h.commands.get("reset").handler("", h.ctx); }

function completeCompaction(h, requestId = "r1") {
  const marker = h.branch.find((entry) => entry.customType === RESET_MARKER_TYPE && entry.data.requestId === requestId);
  h.compactions.at(-1).onComplete({ summary: "", firstKeptEntryId: marker.id, tokensBefore: 123 });
}

test("registers /reset and supplies a real marker to custom compaction before prepare", async () => {
  const h = harness(); await request(h);
  assert.deepEqual([...h.commands.keys()], ["reset"]);
  assert.equal(h.sent.length, 0); assert.equal(h.compactions.length, 1);
  const marker = h.branch.find((entry) => entry.customType === RESET_MARKER_TYPE);
  assert.ok(marker.id);
  const replacement = h.beforeCompact();
  assert.equal(replacement.compaction.summary, "");
  assert.equal(replacement.compaction.firstKeptEntryId, marker.id);
  assert.equal(replacement.compaction.tokensBefore, 123);
  completeCompaction(h);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, RESET_MESSAGE_TYPE);
  assert.equal(h.sent[0].message.details.mode, "compaction");
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(h.handlers.get("context")({ messages: [{ role: "custom", ...h.sent[0].message }] }, h.ctx).messages, [h.sent[0].message]);
  assert.deepEqual(h.handlers.get("context")({ messages: [{ role: "assistant", content: "later" }] }, h.ctx).messages, [{ role: "assistant", content: "later" }]);
  h.handlers.get("message_start")({ message: { role: "custom", ...h.sent[0].message } }, h.ctx);
  h.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx);
  assert.equal(h.entries.filter((entry) => entry.customType === RESET_STATE_TYPE && entry.data.status === "completed").length, 1);
});

test("default reset factory detects an active specification", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "prime-ralph-default-reset-"));
  mkdirSync(join(cwd, ".ralph/plans"), { recursive: true });
  mkdirSync(join(cwd, ".ralph/skills/prepare"), { recursive: true });
  mkdirSync(join(cwd, ".ralph/skills/spec-it-out"), { recursive: true });
  writeFileSync(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# Existing\n");
  writeFileSync(join(cwd, ".ralph/skills/prepare/SKILL.md"), "---\nname: prepare\ndescription: test\n---\nprepare");
  writeFileSync(join(cwd, ".ralph/skills/spec-it-out/SKILL.md"), "---\nname: spec-it-out\ndescription: test\nprime-ralph-invocation-version: 1\n---\nspec");
  const h = harness(); h.ctx.cwd = cwd;
  const pi = { registerCommand: (name, value) => h.commands.set(name, value), on: (name, value) => h.handlers.set(name, value), appendEntry: (type, data) => { const entry = { type: "custom", id: `d${h.branch.length}`, customType: type, data }; h.entries.push(entry); h.branch.push(entry); }, sendMessage: (message, options) => { h.sent.push({ message, options }); h.branch.push({ type: "custom_message", ...message }); } };
  createResetExtension({ createRequestId: () => "default-request" })(pi);
  await h.commands.get("reset").handler("", h.ctx); h.compactions.at(-1).onError(new Error("Session is too short to compact"));
  assert.match(h.sent[0].message.content, /"invocationMode":"specification-reset-existing"/);
});

test("existing-spec reset delivers prepare first and bounded reset-existing guidance second", async () => {
  const h = harness({ specificationState: "existing" }); await request(h); completeCompaction(h);
  const content = h.sent[0].message.content;
  assert.ok(content.indexOf('<skill name="prepare"') < content.indexOf("<prime-ralph-invocation>"));
  assert.match(content, /"invocationMode":"specification-reset-existing"/);
  assert.match(content, /<skill name="spec-it-out"/);
});

test("specification conflicts fail before reset markers or compaction", async () => {
  const h = harness();
  const pi = { registerCommand: (name, value) => h.commands.set(name, value), on: () => {}, appendEntry: (...args) => h.entries.push(args), sendMessage: (...args) => h.sent.push(args) };
  createResetExtension({ inspectSpecification: () => { throw new Error("path conflict"); } })(pi);
  await assert.rejects(h.commands.get("reset").handler("", h.ctx), /path conflict/);
  assert.equal(h.entries.length, 0); assert.equal(h.compactions.length, 0);
});

test("validates existing-spec skill before recording a marker or reset state", async () => {
  const h = harness();
  const pi = { registerCommand: (name, value) => h.commands.set(name, value), on: () => {}, appendEntry: (...args) => h.entries.push(args), sendMessage: (...args) => h.sent.push(args) };
  createResetExtension({ inspectSpecification: () => ({ state: "existing" }), loadPrepare: () => ({ path: "prepare", text: "prepare" }), loadSpecItOut: () => { throw new Error("incompatible spec skill"); } })(pi);
  await assert.rejects(h.commands.get("reset").handler("", h.ctx), /incompatible spec skill/);
  assert.equal(h.entries.length, 0); assert.equal(h.compactions.length, 0);
});

test("validates prepare before recording a marker or reset state", async () => {
  const h = harness();
  const pi = { registerCommand: (name, value) => h.commands.set(name, value), on: () => {}, appendEntry: (...args) => h.entries.push(args), sendMessage: (...args) => h.sent.push(args) };
  createResetExtension({ loadPrepare: () => { throw new Error("missing prepare"); } })(pi);
  await assert.rejects(h.commands.get("reset").handler("", h.ctx), /missing prepare/);
  assert.equal(h.entries.length, 0); assert.equal(h.sent.length, 0);
});

test("coalesces a duplicate while compaction or prepare is pending and permits the next settled reset", async () => {
  const h = harness(); await request(h); await request(h);
  assert.equal(h.compactions.length, 1); assert.match(h.notices.at(-1)[0], /already pending/);
  completeCompaction(h);
  await request(h);
  assert.equal(h.compactions.length, 1);
  h.handlers.get("message_start")({ message: { role: "custom", ...h.sent[0].message } }, h.ctx);
  h.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx);
  await request(h);
  assert.equal(h.compactions.length, 2);
  const requestIds = h.branch.filter((entry) => entry.customType === RESET_MARKER_TYPE).map((entry) => entry.data.requestId);
  assert.deepEqual(requestIds, ["r1", "r2"]);
});

test("uses projection fallback only for host short-session refusal", async () => {
  const h = harness(); await request(h);
  h.compactions[0].onError(new Error("Session is too short to compact — try again once it grows"));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.details.mode, "projection-fallback");
  const boundary = { role: "custom", ...h.sent[0].message };
  const initial = h.handlers.get("context")({ messages: [boundary] }, h.ctx);
  assert.deepEqual(initial.messages, [h.sent[0].message]);
  const projected = h.handlers.get("context")({ messages: [{ role: "user", content: "stale" }, boundary] }, h.ctx);
  assert.deepEqual(projected.messages, [boundary]);
});

test("does not intercept ordinary compaction or nonmatching markers", async () => {
  const h = harness(); await request(h);
  assert.equal(h.beforeCompact("ordinary user compaction"), undefined);
  h.branch.find((entry) => entry.customType === RESET_MARKER_TYPE).data.requestId = "tampered";
  assert.deepEqual(h.beforeCompact(), { cancel: true });
});

test("fails without prepare on compaction failure or unexpected result", async () => {
  const failed = harness(); await request(failed);
  failed.compactions[0].onError(new Error("provider unavailable"));
  assert.equal(failed.sent.length, 0);
  assert.equal(failed.entries.at(-1).data.status, "failed");
  assert.equal(failed.entries.at(-1).data.reason, "compaction_failed");

  const unexpected = harness(); await request(unexpected);
  unexpected.compactions[0].onComplete({ summary: "wrong", firstKeptEntryId: "wrong", tokensBefore: 1 });
  assert.equal(unexpected.sent.length, 0);
  assert.equal(unexpected.entries.at(-1).data.reason, "unexpected_compaction_result");
});

test("converts synchronous prepare admission failure into terminal failed state", async () => {
  const h = harness({ sendError: new Error("admission unavailable") }); await request(h);
  try { completeCompaction(h); } catch (error) { h.compactions[0].onError(error); }
  assert.equal(h.sent.length, 0);
  assert.equal(h.entries.at(-1).data.status, "failed");
  assert.equal(h.entries.at(-1).data.reason, "skill_admission_failed");
});

test("reload recovers a persisted prepare boundary without replay", () => {
  const branch = [
    { type: "custom", id: "m", customType: RESET_MARKER_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: "r1" } },
    { type: "custom", id: "s", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: "r1", status: "prepare_pending" } },
    { type: "custom_message", id: "p", customType: RESET_MESSAGE_TYPE, details: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: "r1", mode: "compaction" } },
  ];
  const h = harness({ branch }); h.handlers.get("session_start")({}, h.ctx);
  assert.equal(h.sent.length, 0); assert.equal(h.entries.at(-1).data.status, "recovered");
  assert.equal(h.entries.at(-1).data.boundaryExists, true);
});

test("reload reports a compacted request whose prepare was not admitted", () => {
  const branch = [
    { type: "custom", id: "s", customType: RESET_STATE_TYPE, data: { source: "prime-ralph", protocolVersion: RESET_PROTOCOL_VERSION, requestId: "lost", status: "prepare_pending" } },
    { type: "compaction", id: "c", summary: "", customInstructions: resetCompactionInstructions("lost") },
  ];
  const h = harness({ branch }); h.handlers.get("session_start")({}, h.ctx);
  assert.equal(h.sent.length, 0); assert.equal(h.entries.at(-1).data.status, "recovered");
  assert.equal(h.entries.at(-1).data.compactionExists, true);
  assert.match(h.notices.at(-1)[0], /before prepare was admitted/);
});


test("records provider error after a durable prepare boundary without replay", async () => {
  const h = harness(); await request(h); completeCompaction(h);
  h.handlers.get("message_start")({ message: { role: "custom", ...h.sent[0].message } }, h.ctx);
  h.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "secret text" }] }, h.ctx);
  assert.equal(h.entries.at(-1).data.status, "failed");
  assert.equal(h.entries.at(-1).data.reason, "provider_error");
  assert.equal(JSON.stringify(h.entries.at(-1)).includes("secret text"), false);
  assert.equal(h.sent.length, 1);
});

test("shutdown records an interrupted in-flight reset", async () => {
  const h = harness(); await request(h);
  h.handlers.get("session_shutdown")({ reason: "reload" }, h.ctx);
  assert.equal(h.entries.at(-1).data.status, "interrupted");
  assert.equal(h.entries.at(-1).data.reason, "reload");
});
