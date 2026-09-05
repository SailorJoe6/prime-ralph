import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_SKILLS } from "../src/init.js";
import { validateCanonicalSkill } from "../src/reset-skill.js";

const root = fileURLToPath(new URL("../templates", import.meta.url));
function load(variant, skill) {
  const bytes = readFileSync(join(root, variant, skill, "SKILL.md"));
  assert.ok(bytes.byteLength <= 128 * 1024);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function validate(text, expectedName) { assert.equal(validateCanonicalSkill(text, expectedName), true); }

test("both bundled template sets are complete, strict, and independent", () => {
  for (const variant of ["default", "beads"]) for (const skill of CANONICAL_SKILLS) {
    const text = load(variant, skill); validate(text, skill);
    assert.doesNotMatch(text, /sailorjoe|openclaw|nemoclaw|parent repository|\/home\//i);
    if (variant === "default") assert.doesNotMatch(text, /\bbd\b|\bbeads\b/i);
  }
});

test("mode templates do not duplicate prepare or activate later phases implicitly", () => {
  for (const variant of ["default", "beads"]) for (const skill of CANONICAL_SKILLS.filter((name) => name !== "prepare")) {
    const text = load(variant, skill);
    assert.doesNotMatch(text, /run (?:the )?prepare|load (?:the )?prepare/i);
  }
  assert.match(load("default", "prepare"), /Do not select a Ralph phase/);
});

test("specification templates protect the active specification and cleared-source case", () => {
  for (const variant of ["default", "beads"]) {
    const text = load(variant, "spec-it-out");
    for (const pattern of [/\.ralph\/plans\/SPECIFICATION\.md/, /prime-ralph-invocation/, /specification-new/, /specification-existing/, /specification-reset-existing/, /future specification/i, /explicit confirmation/i, /update it in place only after explicit agreement/i, /Cancel without changing/i, /reset cleared the conversation/i, /do not offer future-specification creation/i]) assert.match(text, pattern);
    assert.match(text, /prime-ralph-invocation-version:\s*1/);
    assert.doesNotMatch(text, /execution lifecycle is running|must first pause|native control/i);
  }
});

test("planning templates protect plans and never start execution", () => {
  for (const variant of ["default", "beads"]) {
    const text = load(variant, "plan");
    for (const pattern of [/\.ralph\/plans\/SPECIFICATION\.md/, /\.ralph\/plans\/EXECUTION_PLAN\.md/, /prime-ralph-invocation/, /planning-new/, /planning-existing/, /planning-reset-new/, /planning-reset-existing/, /do not overwrite/i, /Offer exactly these choices/i, /Discuss the active execution plan/i, /in-place update only after/i, /Cancel without changing/i, /must not start execution/i]) assert.match(text, pattern);
    assert.match(text, /prime-ralph-invocation-version:\s*1/);
    assert.doesNotMatch(text, /execution lifecycle is running|must first pause|native control/i);
  }
});

test("execute templates enforce the same cycle-sized work-unit gate", () => {
  const sections = ["default", "beads"].map((variant) => {
    const text = load(variant, "execute");
    const section = text.match(/## Cycle-sized work-unit gate\n([\s\S]*?)(?=\n## Native execution driver)/)?.[1];
    assert.ok(section, `${variant} cycle-sized gate is missing`);
    for (const pattern of [/independently testable behavior, transition, or failure window/i, /exact exit condition/i, /major affected surface groups/i, /not included this cycle/i, /more than about three major surface groups/i, /25[–-]35%/, /near 25% context use/i, /35[–-]40%/, /final 20%/, /safety-invalidating/i, /required acceptance/i, /adjacent hardening/i, /minimum tests and documentation/i, /leave the affected behavior unpublished/i, /only this cycle's affected behavior/i, /normal lifecycle decisions/i, /does not authorize an invented transition/i, /incomplete publication/i, /loss of unrelated work/i]) assert.match(section, pattern);
    return section;
  });
  assert.equal(sections[0], sections[1]);
});

test("execute templates define continue, wait, block, and complete semantics", () => {
  for (const variant of ["default", "beads"]) {
    const text = load(variant, "execute");
    for (const pattern of [/single highest-value task/i, /\*\*Continue:\*\*/, /\*\*Wait:\*\*/, /same Ralph lifecycle/i, /clean context projection/i, /evidence that establishes readiness/i, /successful `ready` call.*end the assistant turn immediately/is, /`recover-driver`.*does not log or advance the cycle/is, /\*\*Blocked:\*\*/, /exact active pair without overwrite/i, /Stop\/delete any agent-owned wakeup/i, /tell the user what help is required/i, /\*\*Complete:\*\*/, /Audit every specification requirement/i, /native driver cannot continue/i, /final response must identify/i]) assert.match(text, pattern);
    assert.doesNotMatch(text, /complete the goal when.*wait|plugin continuation loop is the driver/i);
  }
});

test("blocked templates require conflict-safe paired restore and explicit user restart", () => {
  for (const variant of ["default", "beads"]) {
    const text = load(variant, "blocked");
    for (const pattern of [/blocked-start.*blocked-reset/i, /restore both documents together/i, /without overwrit/i, /partial pair.*not success/i, /blocked-restored/i, /Do not edit or move them before confirmation/i, /Do not call `unblock`/i, /call `confirm-forward`/i, /`\/execute` starts a fresh execution run/i]) assert.match(text, pattern);
  }
});

test("Beads templates add explicit issue workflow without changing frontmatter identity", () => {
  assert.match(load("beads", "prepare"), /`bd prime`/);
  for (const skill of ["plan", "execute", "blocked"]) assert.match(load("beads", skill), /Beads/);
});
