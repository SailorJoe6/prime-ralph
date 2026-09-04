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
    for (const pattern of [/\.ralph\/plans\/SPECIFICATION\.md/, /future specification/i, /explicit confirmation/i, /update it in place only after explicit agreement/i, /Cancel without changing/i, /reset cleared the conversation/i, /do not offer future-specification creation/i]) assert.match(text, pattern);
    assert.match(text, /must first pause/i);
  }
});

test("planning templates protect plans and never start execution", () => {
  for (const variant of ["default", "beads"]) {
    const text = load(variant, "plan");
    for (const pattern of [/\.ralph\/plans\/SPECIFICATION\.md/, /\.ralph\/plans\/EXECUTION_PLAN\.md/, /do not overwrite/i, /explicitly requested in-place update/i, /cancel/i, /must not start execution/i, /must first pause/i]) assert.match(text, pattern);
  }
});

test("execute templates define continue, wait, block, and complete semantics", () => {
  for (const variant of ["default", "beads"]) {
    const text = load(variant, "execute");
    for (const pattern of [/single highest-value task/i, /\*\*Continue:\*\*/, /\*\*Wait:\*\*/, /same lifecycle/i, /no context reset/i, /readiness control only after/i, /\*\*Blocked:\*\*/, /exact active specification and plan together/i, /stop continuation and associated wakeups/i, /request the specific help/i, /\*\*Complete:\*\*/, /Audit every specification requirement/i, /stop the execution driver/i, /final response must identify/i]) assert.match(text, pattern);
    assert.doesNotMatch(text, /complete the goal when.*wait|create a new goal/i);
  }
});

test("blocked templates require conflict-safe paired restore and explicit user restart", () => {
  for (const variant of ["default", "beads"]) {
    const text = load(variant, "blocked");
    for (const pattern of [/matching current-lifecycle pair/i, /restore both documents together/i, /Neither active destination may be overwritten/i, /partial restore.*not success/i, /Do not resume automatically/i, /invoke `\/execute`/i]) assert.match(text, pattern);
  }
});

test("Beads templates add explicit issue workflow without changing frontmatter identity", () => {
  assert.match(load("beads", "prepare"), /`bd prime`/);
  for (const skill of ["plan", "execute", "blocked"]) assert.match(load("beads", skill), /Beads/);
});
