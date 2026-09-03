import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPrepareInjection, loadPrepareSkill, PrepareSkillError, validatePrepareSkill } from "../src/reset-skill.js";

const valid = "---\nname: prepare\ndescription: test\n---\n\nStudy this project.\n";
function project() { const cwd = mkdtempSync(join(tmpdir(), "prime-ralph-skill-")); mkdirSync(join(cwd, ".ralph/skills/prepare"), { recursive: true }); return cwd; }

test("loads only the canonical prepare skill and preserves its exact text", () => {
  const cwd = project(); const path = join(cwd, ".ralph/skills/prepare/SKILL.md"); writeFileSync(path, valid);
  const skill = loadPrepareSkill({ cwd });
  assert.equal(skill.path, path); assert.equal(skill.text, valid);
  const injection = formatPrepareInjection(skill);
  assert.equal(injection.split(valid).length - 1, 1);
  assert.match(injection, /^<skill name="prepare" location=/);
});

test("fails before injection for missing, oversized, invalid UTF-8, and malformed skills", () => {
  const missing = project(); assert.throws(() => loadPrepareSkill({ cwd: missing }), PrepareSkillError);
  const oversized = project(); writeFileSync(join(oversized, ".ralph/skills/prepare/SKILL.md"), valid);
  assert.throws(() => loadPrepareSkill({ cwd: oversized, maxBytes: 8 }), /exceeds/);
  const invalidUtf8 = project(); writeFileSync(join(invalidUtf8, ".ralph/skills/prepare/SKILL.md"), Buffer.from([0xff, 0xfe]));
  assert.throws(() => loadPrepareSkill({ cwd: invalidUtf8 }), /UTF-8/);
  assert.throws(() => validatePrepareSkill("plain markdown"), /frontmatter/);
  assert.throws(() => validatePrepareSkill("---\nname: execute\n---\nbody"), /name: prepare/);
  assert.throws(() => validatePrepareSkill("---\nname: prepare\nname: execute\n---\nbody"), /invalid YAML/);
  assert.throws(() => validatePrepareSkill("---\nname: prepare\n---\nbody"), /description/);
  assert.throws(() => validatePrepareSkill("---\nname: [prepare\n---\nbody"), /invalid YAML/);
  assert.equal(validatePrepareSkill("---\nname: 'prepare'\ndescription: valid\n---\nbody"), true);
  assert.throws(() => validatePrepareSkill("---\nname: prepare\ndescription: test\n---\n"), /body is empty/);
});
