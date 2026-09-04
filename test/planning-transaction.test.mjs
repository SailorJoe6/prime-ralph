import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ACTIVE_EXECUTION_PLAN_PATH, ACTIVE_SPECIFICATION_PATH,
  ARCHIVE_ROOT_PATH, archivePlanningPaths, inspectBlockedPlanningTransaction,
  BLOCKED_EXECUTION_PLAN_PATH, BLOCKED_PROVENANCE_PATH, BLOCKED_SPECIFICATION_PATH,
  MAX_TRANSACTION_DOCUMENT_BYTES, PlanningTransactionError, archivePlanningDocuments, blockPlanningDocuments,
  moveFileNoReplaceSync, unblockPlanningDocuments,
} from "../src/planning-transaction.js";

const ARCHIVE = archivePlanningPaths("release-1");
const [ARCHIVE_SPECIFICATION_PATH, ARCHIVE_EXECUTION_PLAN_PATH] = ARCHIVE.documents;
const ARCHIVE_PROVENANCE_PATH = ARCHIVE.provenance;

function project() {
  const cwd = mkdtempSync(join(tmpdir(), "prime-ralph-transaction-"));
  for (const path of [".ralph/plans/blocked", ".ralph/plans/archive"]) mkdirSync(join(cwd, path), { recursive: true });
  return cwd;
}
function active(cwd, { spec = "spec", plan = "plan" } = {}) {
  writeFileSync(join(cwd, ACTIVE_SPECIFICATION_PATH), spec);
  writeFileSync(join(cwd, ACTIVE_EXECUTION_PLAN_PATH), plan);
}
function blocked(cwd, id = "life-1") {
  active(cwd);
  blockPlanningDocuments({ cwd, lifecycleId: id, now: () => "2026-01-02T03:04:05.000Z" });
}
function contents(cwd, paths) {
  return paths.map((path) => existsSync(join(cwd, path)) ? readFileSync(join(cwd, path), "utf8") : undefined);
}

for (const operation of ["block", "archive"]) {
  test(`${operation} moves the exact active pair and records lifecycle provenance`, () => {
    const cwd = project(); active(cwd, { spec: "S", plan: "P" });
    const result = operation === "block"
      ? blockPlanningDocuments({ cwd, lifecycleId: "life-1", now: () => 0 })
      : archivePlanningDocuments({ cwd, lifecycleId: "life-1", archiveName: "release-1", now: () => 0 });
    const destinations = operation === "block"
      ? [BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH]
      : [ARCHIVE_SPECIFICATION_PATH, ARCHIVE_EXECUTION_PLAN_PATH];
    const markerPath = operation === "block" ? BLOCKED_PROVENANCE_PATH : ARCHIVE_PROVENANCE_PATH;
    assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]), [undefined, undefined]);
    assert.deepEqual(contents(cwd, destinations), ["S", "P"]);
    const marker = JSON.parse(readFileSync(join(cwd, markerPath), "utf8"));
    assert.equal(marker.transition, operation); assert.equal(marker.lifecycleId, "life-1");
    assert.deepEqual(marker.documents.map(({ bytes }) => bytes), [1, 1]);
    assert.deepEqual(marker.documents.map(({ sha256 }) => sha256), [createHash("sha256").update("S").digest("hex"), createHash("sha256").update("P").digest("hex")]);
    assert.equal(marker.createdAt, "1970-01-01T00:00:00.000Z");
    assert.equal(result.provenancePath, markerPath);
  });
}

test("unblock restores the matching pair, removes provenance, and does not auto-archive", () => {
  const cwd = project(); blocked(cwd, "life-1");
  const result = unblockPlanningDocuments({ cwd, lifecycleId: "life-1" });
  assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]), ["spec", "plan"]);
  assert.deepEqual(contents(cwd, [BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH, BLOCKED_PROVENANCE_PATH]), [undefined, undefined, undefined]);
  assert.deepEqual(contents(cwd, [ARCHIVE_SPECIFICATION_PATH, ARCHIVE_EXECUTION_PLAN_PATH]), [undefined, undefined]);
  assert.equal(result.provenancePath, undefined);
});

for (const [label, setup, invoke, pattern] of [
  ["partial active source", (cwd) => writeFileSync(join(cwd, ACTIVE_SPECIFICATION_PATH), "S"), blockPlanningDocuments, /active planning document pair must be complete; found partial/],
  ["absent active source", () => {}, archivePlanningDocuments, /active planning document pair must be complete; found absent/],
  ["partial blocked destination", (cwd) => { active(cwd); writeFileSync(join(cwd, BLOCKED_SPECIFICATION_PATH), "old"); }, blockPlanningDocuments, /blocked planning document destination must be absent; found partial/],
  ["complete blocked destination", (cwd) => { active(cwd); writeFileSync(join(cwd, BLOCKED_SPECIFICATION_PATH), "old S"); writeFileSync(join(cwd, BLOCKED_EXECUTION_PLAN_PATH), "old P"); }, blockPlanningDocuments, /blocked planning document destination must be absent; found complete/],
  ["existing named archive destination", (cwd) => { active(cwd); mkdirSync(join(cwd, ARCHIVE.directory)); writeFileSync(join(cwd, ARCHIVE_EXECUTION_PLAN_PATH), "old"); }, archivePlanningDocuments, /archive destination already exists/],
]) {
  test(`preflight rejects ${label} without changing documents`, () => {
    const cwd = project(); setup(cwd); const before = contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH, BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH, ARCHIVE_SPECIFICATION_PATH, ARCHIVE_EXECUTION_PLAN_PATH]);
    assert.throws(() => invoke({ cwd, lifecycleId: "life-1", ...(invoke === archivePlanningDocuments ? { archiveName: "release-1" } : {}) }), pattern);
    assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH, BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH, ARCHIVE_SPECIFICATION_PATH, ARCHIVE_EXECUTION_PLAN_PATH]), before);
  });
}

test("unblock rejects a partial blocked source without changing it", () => {
  const cwd = project(); writeFileSync(join(cwd, BLOCKED_SPECIFICATION_PATH), "S");
  assert.throws(() => unblockPlanningDocuments({ cwd, lifecycleId: "life-1" }), /blocked planning document pair must be complete; found partial/);
  assert.equal(readFileSync(join(cwd, BLOCKED_SPECIFICATION_PATH), "utf8"), "S");
});

test("unblock rejects missing, malformed, and stale lifecycle provenance", () => {
  for (const kind of ["missing", "malformed", "stale"]) {
    const cwd = project(); blocked(cwd, "life-1");
    if (kind === "missing") unlinkSync(join(cwd, BLOCKED_PROVENANCE_PATH));
    if (kind === "malformed") writeFileSync(join(cwd, BLOCKED_PROVENANCE_PATH), "{", { flag: "w" });
    assert.throws(() => unblockPlanningDocuments({ cwd, lifecycleId: kind === "stale" ? "life-2" : "life-1" }),
      kind === "missing" ? /provenance is absent/ : kind === "malformed" ? /provenance is invalid/ : /provenance is stale or belongs to another lifecycle/);
    assert.deepEqual(contents(cwd, [BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH]), ["spec", "plan"]);
  }
});

test("blocked content replacement makes provenance stale and unblock rejects without mutation", () => {
  for (const replacedPath of [BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH]) {
    const cwd = project(); blocked(cwd, "life-1");
    const original = readFileSync(join(cwd, replacedPath), "utf8");
    const replacement = original === "spec" ? "evil" : "xxxx"; // same byte size proves SHA-256 is checked.
    writeFileSync(join(cwd, replacedPath), replacement, { flag: "w" });
    assert.equal(inspectBlockedPlanningTransaction({ cwd }).state, "stale");
    assert.throws(() => unblockPlanningDocuments({ cwd, lifecycleId: "life-1" }), /blocked planning contents do not match lifecycle provenance/);
    assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]), [undefined, undefined]);
    assert.equal(readFileSync(join(cwd, replacedPath), "utf8"), replacement);
    assert.equal(existsSync(join(cwd, BLOCKED_PROVENANCE_PATH)), true);
  }
});

test("bounded provenance rejects an oversized planning document before moving either file", () => {
  const cwd = project(); active(cwd, { spec: "x".repeat(MAX_TRANSACTION_DOCUMENT_BYTES + 1), plan: "plan" });
  assert.throws(() => blockPlanningDocuments({ cwd, lifecycleId: "life-1" }), new RegExp(`exceeds ${MAX_TRANSACTION_DOCUMENT_BYTES} bytes`));
  assert.equal(readFileSync(join(cwd, ACTIVE_SPECIFICATION_PATH)).byteLength, MAX_TRANSACTION_DOCUMENT_BYTES + 1);
  assert.equal(readFileSync(join(cwd, ACTIVE_EXECUTION_PLAN_PATH), "utf8"), "plan");
  assert.deepEqual(contents(cwd, [BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH]), [undefined, undefined]);
});

test("block rolls the first document back when the injected second move fails", () => {
  const cwd = project(); active(cwd); let calls = 0;
  const move = (source, destination) => { calls += 1; if (calls === 2) throw new Error("injected second move failure"); moveFileNoReplaceSync(source, destination); };
  assert.throws(() => blockPlanningDocuments({ cwd, lifecycleId: "life-1", move }), (error) => {
    assert.ok(error instanceof PlanningTransactionError); assert.match(error.cause.message, /injected second/); return true;
  });
  assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]), ["spec", "plan"]);
  assert.deepEqual(contents(cwd, [BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH, BLOCKED_PROVENANCE_PATH]), [undefined, undefined, undefined]);
  assert.equal(calls, 3);
});

test("unblock rolls the first document back when the injected second move fails", () => {
  const cwd = project(); blocked(cwd); let calls = 0;
  const move = (source, destination) => { calls += 1; if (calls === 2) throw new Error("injected second move failure"); moveFileNoReplaceSync(source, destination); };
  assert.throws(() => unblockPlanningDocuments({ cwd, lifecycleId: "life-1", move }), /all completed moves were rolled back/);
  assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]), [undefined, undefined]);
  assert.deepEqual(contents(cwd, [BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH]), ["spec", "plan"]);
  assert.equal(existsSync(join(cwd, BLOCKED_PROVENANCE_PATH)), true);
});

test("a provenance write failure rolls both document moves back", () => {
  const cwd = project(); active(cwd);
  assert.throws(() => blockPlanningDocuments({ cwd, lifecycleId: "life-1", writeFile: () => { throw new Error("marker unavailable"); } }), /all completed moves were rolled back/);
  assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]), ["spec", "plan"]);
  assert.deepEqual(contents(cwd, [BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH]), [undefined, undefined]);
});

test("an unblock provenance removal failure rolls documents back and preserves the marker", () => {
  const cwd = project(); blocked(cwd);
  assert.throws(() => unblockPlanningDocuments({ cwd, lifecycleId: "life-1", unlink: () => { throw new Error("marker busy"); } }), /all completed moves were rolled back/);
  assert.deepEqual(contents(cwd, [BLOCKED_SPECIFICATION_PATH, BLOCKED_EXECUTION_PLAN_PATH]), ["spec", "plan"]);
  assert.equal(existsSync(join(cwd, BLOCKED_PROVENANCE_PATH)), true);
});

test("no-replace move preserves a destination created after preflight", () => {
  const cwd = project(); active(cwd); let calls = 0;
  const move = (source, destination) => {
    calls += 1;
    if (calls === 1) writeFileSync(destination, "racing writer");
    moveFileNoReplaceSync(source, destination);
  };
  assert.throws(() => blockPlanningDocuments({ cwd, lifecycleId: "life-1", move }), /planning transaction failed/);
  assert.equal(readFileSync(join(cwd, ACTIVE_SPECIFICATION_PATH), "utf8"), "spec");
  assert.equal(readFileSync(join(cwd, BLOCKED_SPECIFICATION_PATH), "utf8"), "racing writer");
});

test("document symlinks and non-regular conflicts are rejected without following them", () => {
  const outside = project(); writeFileSync(join(outside, "outside"), "secret");
  for (const kind of ["symlink", "directory"]) {
    const cwd = project();
    if (kind === "symlink") symlinkSync(join(outside, "outside"), join(cwd, ACTIVE_SPECIFICATION_PATH));
    else mkdirSync(join(cwd, ACTIVE_SPECIFICATION_PATH));
    writeFileSync(join(cwd, ACTIVE_EXECUTION_PLAN_PATH), "plan");
    assert.throws(() => blockPlanningDocuments({ cwd, lifecycleId: "life-1" }), kind === "symlink" ? /must not be a symlink/ : /not a regular file/);
    assert.equal(readFileSync(join(outside, "outside"), "utf8"), "secret");
  }
});

test("symlink and non-directory parents are rejected", () => {
  const outside = project();
  const linked = mkdtempSync(join(tmpdir(), "prime-ralph-linked-")); mkdirSync(join(linked, ".ralph")); symlinkSync(join(outside, ".ralph/plans"), join(linked, ".ralph/plans"), "dir");
  assert.throws(() => blockPlanningDocuments({ cwd: linked, lifecycleId: "life-1" }), /parent must not be a symlink: \.ralph\/plans/);
  const conflict = mkdtempSync(join(tmpdir(), "prime-ralph-conflict-")); writeFileSync(join(conflict, ".ralph"), "not a dir");
  assert.throws(() => blockPlanningDocuments({ cwd: conflict, lifecycleId: "life-1" }), /parent is not a directory: \.ralph/);
});

test("archive refuses an existing named destination and never overwrites it", () => {
  const cwd = project(); active(cwd); mkdirSync(join(cwd, ARCHIVE.directory)); writeFileSync(join(cwd, ARCHIVE_PROVENANCE_PATH), "old marker");
  assert.throws(() => archivePlanningDocuments({ cwd, lifecycleId: "life-1", archiveName: "release-1" }), /archive destination already exists/);
  assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]), ["spec", "plan"]);
  assert.equal(readFileSync(join(cwd, ARCHIVE_PROVENANCE_PATH), "utf8"), "old marker");
});

test("block and unblock preserve unrelated files under the blocked parent", () => {
  const cwd = project(); active(cwd); writeFileSync(join(cwd, ".ralph/plans/blocked/operator-note.md"), "keep");
  blockPlanningDocuments({ cwd, lifecycleId: "life-1" });
  assert.equal(readFileSync(join(cwd, ".ralph/plans/blocked/operator-note.md"), "utf8"), "keep");
  unblockPlanningDocuments({ cwd, lifecycleId: "life-1" });
  assert.equal(readFileSync(join(cwd, ".ralph/plans/blocked/operator-note.md"), "utf8"), "keep");
});

test("archive requires one safe name segment and preserves unrelated archive entries", () => {
  const invalid = [undefined, "", ".", "..", "../escape", "a/b", "a\\b", ".hidden"];
  for (const archiveName of invalid) {
    const cwd = project(); active(cwd);
    assert.throws(() => archivePlanningDocuments({ cwd, lifecycleId: "life-1", archiveName }), /archiveName must be one safe relative path segment/);
    assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]), ["spec", "plan"]);
  }
  const cwd = project(); active(cwd); mkdirSync(join(cwd, ARCHIVE_ROOT_PATH, "older")); writeFileSync(join(cwd, ARCHIVE_ROOT_PATH, "older/note"), "keep");
  archivePlanningDocuments({ cwd, lifecycleId: "life-1", archiveName: "release-1" });
  assert.equal(readFileSync(join(cwd, ARCHIVE_ROOT_PATH, "older/note"), "utf8"), "keep");
});

test("archive second-move failure rolls back and removes only its new named directory", () => {
  const cwd = project(); active(cwd); mkdirSync(join(cwd, ARCHIVE_ROOT_PATH, "older")); writeFileSync(join(cwd, ARCHIVE_ROOT_PATH, "older/keep"), "yes"); let calls = 0;
  const move = (source, destination) => { calls += 1; if (calls === 2) throw new Error("second move"); moveFileNoReplaceSync(source, destination); };
  assert.throws(() => archivePlanningDocuments({ cwd, lifecycleId: "life-1", archiveName: "release-1", move }), /rolled back/);
  assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]), ["spec", "plan"]);
  assert.equal(existsSync(join(cwd, ARCHIVE.directory)), false);
  assert.equal(readFileSync(join(cwd, ARCHIVE_ROOT_PATH, "older/keep"), "utf8"), "yes");
});

test("blocked inspection distinguishes current provenance from legacy, partial, and stale state", () => {
  const absent = project(); assert.equal(inspectBlockedPlanningTransaction({ cwd: absent }).state, "absent");
  const legacy = project(); writeFileSync(join(legacy, BLOCKED_SPECIFICATION_PATH), "S"); writeFileSync(join(legacy, BLOCKED_EXECUTION_PLAN_PATH), "P");
  assert.equal(inspectBlockedPlanningTransaction({ cwd: legacy }).state, "unproven");
  const partial = project(); writeFileSync(join(partial, BLOCKED_SPECIFICATION_PATH), "S");
  assert.equal(inspectBlockedPlanningTransaction({ cwd: partial }).state, "partial");
  const current = project(); blocked(current, "life-current"); const inspected = inspectBlockedPlanningTransaction({ cwd: current });
  assert.equal(inspected.state, "complete"); assert.equal(inspected.lifecycleId, "life-current"); assert.equal(inspected.provenance.transition, "block");
  writeFileSync(join(current, BLOCKED_PROVENANCE_PATH), JSON.stringify({ ...inspected.provenance, documents: [] }), { flag: "w" });
  assert.equal(inspectBlockedPlanningTransaction({ cwd: current }).state, "stale");
});

test("invalid operations and lifecycle identifiers fail before filesystem mutation", () => {
  const cwd = project(); active(cwd);
  assert.throws(() => blockPlanningDocuments({ cwd, lifecycleId: "" }), /lifecycleId/);
  assert.throws(() => blockPlanningDocuments({ cwd, lifecycleId: "bad\nid" }), /lifecycleId/);
  assert.deepEqual(contents(cwd, [ACTIVE_SPECIFICATION_PATH, ACTIVE_EXECUTION_PLAN_PATH]), ["spec", "plan"]);
});
