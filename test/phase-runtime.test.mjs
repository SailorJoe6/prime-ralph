import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverAndSelectPhase, persistPhaseMarker, selectConfiguredPhase } from "../src/phase-runtime.js";
import { discoverSkillConfig } from "../src/skill-config.js";

test("fixture repositories select different configured phase skills", async () => {
  const a = await mkdtemp("/tmp/prime-ralph-fixture-a-"); const b = await mkdtemp("/tmp/prime-ralph-fixture-b-");
  await mkdir(join(a, ".ralph/skills/execute"), { recursive: true }); await writeFile(join(a, ".ralph/skills/execute/SKILL.md"), "A execute");
  await mkdir(join(b, ".prime-ralph/skills/plan"), { recursive: true }); await writeFile(join(b, ".prime-ralph/skills/plan/SKILL.md"), "B plan");
  const sa = discoverAndSelectPhase({ cwd: a, state: { specExists: true, planExists: true, cycleState: "executing" } });
  const sb = discoverAndSelectPhase({ cwd: b, state: { specExists: true, planExists: false } });
  assert.equal(sa.selection.phase, "execute"); assert.equal(sa.selection.skill.text, "A execute");
  assert.equal(sb.selection.phase, "plan"); assert.equal(sb.selection.skill.text, "B plan");
});

test("missing phase skill is a bounded diagnostic, not a phase-selection failure", async () => {
  const cwd = await mkdtemp("/tmp/prime-ralph-fixture-"); const discovery = discoverSkillConfig({ cwd });
  const selection = selectConfiguredPhase({ state: { specExists: true, planExists: true, cycleState: "executing" }, discovery });
  assert.equal(selection.phase, "execute"); assert.equal(selection.skill, null); assert.deepEqual(selection.diagnostics, []);
});

test("phase selection marker persists only phase and skill identity", () => {
  const markers = []; const marker = persistPhaseMarker((value) => markers.push(value), { phase: "execute", skillIdentity: "execute:/repo/SKILL.md" }, 7);
  assert.deepEqual(marker, { kind: "phase_selection", cycleId: 7, phase: "execute", skillIdentity: "execute:/repo/SKILL.md" }); assert.deepEqual(markers, [marker]);
});
