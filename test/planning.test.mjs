import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_PLAN_RELATIVE_PATH,
  PlanningStateError,
  formatPlanningInjection,
  inspectActivePlan,
  inspectBlockedPlanningDocuments,
  loadPlanSkill,
  planningInvocation,
} from "../src/planning.js";

function project() { return mkdtempSync(join(tmpdir(), "prime-ralph-planning-")); }
function initialized() { const cwd = project(); mkdirSync(join(cwd, ".ralph/plans"), { recursive: true }); return cwd; }
const skillText = "---\nname: plan\ndescription: test\nprime-ralph-invocation-version: 1\n---\nbody";

test("classifies only the exact direct regular execution plan", () => {
  const cwd = initialized();
  assert.equal(inspectActivePlan({ cwd }).state, "absent");
  writeFileSync(join(cwd, ".ralph/plans/future-plan.md"), "ignored");
  mkdirSync(join(cwd, ".ralph/plans/archive")); writeFileSync(join(cwd, ".ralph/plans/archive/EXECUTION_PLAN.md"), "ignored");
  assert.equal(inspectActivePlan({ cwd }).state, "absent");
  writeFileSync(join(cwd, ACTIVE_PLAN_RELATIVE_PATH), "plan\n");
  assert.equal(inspectActivePlan({ cwd }).state, "existing");
});

test("rejects conflicting plan parents and target without following symlinks", () => {
  for (const conflict of ["ralph-file", "ralph-symlink", "plans-file", "plans-symlink", "target-directory", "target-symlink"]) {
    const cwd = project(), outside = project();
    if (conflict === "ralph-file") writeFileSync(join(cwd, ".ralph"), "x");
    if (conflict === "ralph-symlink") symlinkSync(outside, join(cwd, ".ralph"), "dir");
    if (conflict.startsWith("plans-") || conflict.startsWith("target-")) mkdirSync(join(cwd, ".ralph"));
    if (conflict === "plans-file") writeFileSync(join(cwd, ".ralph/plans"), "x");
    if (conflict === "plans-symlink") symlinkSync(outside, join(cwd, ".ralph/plans"), "dir");
    if (conflict.startsWith("target-")) mkdirSync(join(cwd, ".ralph/plans"));
    if (conflict === "target-directory") mkdirSync(join(cwd, ACTIVE_PLAN_RELATIVE_PATH));
    if (conflict === "target-symlink") { writeFileSync(join(outside, "plan"), "outside"); symlinkSync(join(outside, "plan"), join(cwd, ACTIVE_PLAN_RELATIVE_PATH)); }
    const expected = conflict.endsWith("symlink")
      ? /must not be a symlink: .*; replace it with a (?:real directory|regular file) or remove it, then retry/
      : /is not a (?:directory|regular file): .*; replace it with a (?:real directory|regular file) or remove it, then retry/;
    assert.throws(() => inspectActivePlan({ cwd }), expected, conflict);
  }
});

test("loads only a compatible canonical plan skill", () => {
  const cwd = project(); mkdirSync(join(cwd, ".ralph/skills/plan"), { recursive: true });
  writeFileSync(join(cwd, ".ralph/skills/plan/SKILL.md"), skillText);
  assert.equal(loadPlanSkill({ cwd }).text, skillText);
  writeFileSync(join(cwd, ".ralph/skills/plan/SKILL.md"), "---\nname: plan\ndescription: old\n---\nbody");
  assert.throws(() => loadPlanSkill({ cwd }), /prime-ralph-invocation-version: 1/);
});

test("formats closed bounded planning facts before the skill", () => {
  assert.deepEqual(planningInvocation("planning-reset-existing"), { protocolVersion: 1, specificationState: "existing", planState: "existing", invocationMode: "planning-reset-existing" });
  const text = formatPlanningInjection({ path: '/p/plan"<&', text: skillText }, "planning-new");
  assert.match(text, /^<prime-ralph-invocation>\{/);
  assert.match(text, /"specificationState":"existing"/);
  assert.match(text, /"planState":"absent"/);
  assert.match(text, /"invocationMode":"planning-new"/);
  assert.doesNotMatch(text.split("</prime-ralph-invocation>")[0], /EXECUTION_PLAN|command/);
  assert.match(text, /location="\/p\/plan&quot;&lt;&amp;"/);
  assert.throws(() => planningInvocation("execute"), /unknown planning invocation mode/);
});


test("classifies only exact blocked planning documents and rejects conflicts", () => {
  const cwd = initialized(); mkdirSync(join(cwd, ".ralph/plans/blocked"));
  assert.equal(inspectBlockedPlanningDocuments({ cwd }).state, "absent");
  writeFileSync(join(cwd, ".ralph/plans/blocked/SPECIFICATION.md"), "spec");
  assert.equal(inspectBlockedPlanningDocuments({ cwd }).state, "partial");
  writeFileSync(join(cwd, ".ralph/plans/blocked/EXECUTION_PLAN.md"), "plan");
  assert.equal(inspectBlockedPlanningDocuments({ cwd }).state, "complete");
  const conflict = initialized(), outside = project(); symlinkSync(outside, join(conflict, ".ralph/plans/blocked"), "dir");
  assert.throws(
    () => inspectBlockedPlanningDocuments({ cwd: conflict }),
    /blocked planning parent must not be a symlink: \.ralph\/plans\/blocked; replace it with a real directory or remove it, then retry/,
  );
  const linkedDocument = initialized(); mkdirSync(join(linkedDocument, ".ralph/plans/blocked"));
  writeFileSync(join(outside, "blocked-spec"), "outside");
  symlinkSync(join(outside, "blocked-spec"), join(linkedDocument, ".ralph/plans/blocked/SPECIFICATION.md"));
  assert.throws(
    () => inspectBlockedPlanningDocuments({ cwd: linkedDocument }),
    /blocked planning document must not be a symlink: \.ralph\/plans\/blocked\/SPECIFICATION\.md; replace it with a regular file or remove it, then retry/,
  );
});


test("rejects missing, oversized, invalid UTF-8, malformed, and duplicate-key plan skills", () => {
  const missing = project(); assert.throws(() => loadPlanSkill({ cwd: missing }), /unavailable/);
  const cwd = project(); mkdirSync(join(cwd, ".ralph/skills/plan"), { recursive: true }); const path = join(cwd, ".ralph/skills/plan/SKILL.md");
  writeFileSync(path, Buffer.alloc(129 * 1024, 65)); assert.throws(() => loadPlanSkill({ cwd }), /exceeds/);
  writeFileSync(path, Buffer.from([0xff, 0xfe])); assert.throws(() => loadPlanSkill({ cwd }), /valid UTF-8/);
  writeFileSync(path, "not frontmatter"); assert.throws(() => loadPlanSkill({ cwd }), /YAML frontmatter/);
  writeFileSync(path, "---\nname: plan\nname: plan\ndescription: duplicate\nprime-ralph-invocation-version: 1\n---\nbody"); assert.throws(() => loadPlanSkill({ cwd }), /invalid YAML|duplicate key|Map keys must be unique/i);
});
