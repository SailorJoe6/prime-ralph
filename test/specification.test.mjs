import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_SPECIFICATION_RELATIVE_PATH,
  SpecificationStateError,
  formatSpecificationInjection,
  inspectActiveSpecification,
  loadSpecItOutSkill,
} from "../src/specification.js";

function project() { return mkdtempSync(join(tmpdir(), "prime-ralph-specification-")); }
function initialized() { const cwd = project(); mkdirSync(join(cwd, ".ralph/plans"), { recursive: true }); return cwd; }
const skillText = "---\nname: spec-it-out\ndescription: test\nprime-ralph-invocation-version: 1\n---\nbody";

test("classifies only an exact regular active specification as existing", () => {
  const cwd = initialized();
  assert.equal(inspectActiveSpecification({ cwd }).state, "absent");
  writeFileSync(join(cwd, ACTIVE_SPECIFICATION_RELATIVE_PATH), "spec\n");
  const result = inspectActiveSpecification({ cwd });
  assert.equal(result.state, "existing");
  assert.equal(result.relativePath, ACTIVE_SPECIFICATION_RELATIVE_PATH);
});

test("treats missing control parents as absent without creating them", () => {
  const cwd = project();
  assert.equal(inspectActiveSpecification({ cwd }).state, "absent");
});

test("rejects conflicting parent and destination path types without following symlinks", () => {
  for (const conflict of ["ralph-file", "ralph-symlink", "plans-file", "plans-symlink", "target-directory", "target-symlink"]) {
    const cwd = project(), outside = project();
    if (conflict === "ralph-file") writeFileSync(join(cwd, ".ralph"), "x");
    if (conflict === "ralph-symlink") symlinkSync(outside, join(cwd, ".ralph"), "dir");
    if (conflict.startsWith("plans-") || conflict.startsWith("target-")) mkdirSync(join(cwd, ".ralph"));
    if (conflict === "plans-file") writeFileSync(join(cwd, ".ralph/plans"), "x");
    if (conflict === "plans-symlink") symlinkSync(outside, join(cwd, ".ralph/plans"), "dir");
    if (conflict.startsWith("target-")) mkdirSync(join(cwd, ".ralph/plans"));
    if (conflict === "target-directory") mkdirSync(join(cwd, ACTIVE_SPECIFICATION_RELATIVE_PATH));
    if (conflict === "target-symlink") { writeFileSync(join(outside, "spec"), "outside"); symlinkSync(join(outside, "spec"), join(cwd, ACTIVE_SPECIFICATION_RELATIVE_PATH)); }
    assert.throws(() => inspectActiveSpecification({ cwd }), SpecificationStateError, conflict);
  }
});

test("loads and validates the canonical spec-it-out skill", () => {
  const cwd = project(); mkdirSync(join(cwd, ".ralph/skills/spec-it-out"), { recursive: true });
  writeFileSync(join(cwd, ".ralph/skills/spec-it-out/SKILL.md"), skillText);
  assert.equal(loadSpecItOutSkill({ cwd }).text, skillText);
  writeFileSync(join(cwd, ".ralph/skills/spec-it-out/SKILL.md"), "---\nname: wrong\ndescription: x\n---\nbody");
  assert.throws(() => loadSpecItOutSkill({ cwd }), /frontmatter must declare name: spec-it-out/);
});

test("rejects pre-Slice-3 skills that cannot consume authoritative invocation metadata", () => {
  const cwd = project(); mkdirSync(join(cwd, ".ralph/skills/spec-it-out"), { recursive: true });
  writeFileSync(join(cwd, ".ralph/skills/spec-it-out/SKILL.md"), "---\nname: spec-it-out\ndescription: old\n---\nlegacy body");
  assert.throws(() => loadSpecItOutSkill({ cwd }), /prime-ralph-invocation-version: 1/);
});

test("formats bounded explicit invocation metadata before the skill", () => {
  const text = formatSpecificationInjection({ path: '/p/skill"<&', text: skillText }, "specification-existing");
  assert.match(text, /^<prime-ralph-invocation>\{/);
  assert.match(text, /"protocolVersion":1/);
  assert.match(text, /"specificationState":"existing"/);
  assert.match(text, /"invocationMode":"specification-existing"/);
  assert.doesNotMatch(text.split("</prime-ralph-invocation>")[0], /SPECIFICATION\.md|command/);
  assert.match(text, /location="\/p\/skill&quot;&lt;&amp;"/);
  assert.throws(() => formatSpecificationInjection({ path: "p", text: skillText }, "running"), /unknown specification invocation mode/);
});
