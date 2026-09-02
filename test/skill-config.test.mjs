import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverSkillConfig, selectPhase } from "../src/skill-config.js";

 test("skill discovery applies explicit, environment, then repository precedence", async () => {
  const cwd = await mkdtemp("/tmp/prime-ralph-skills-");
  await mkdir(join(cwd, ".ralph/skills/execute"), { recursive: true }); await writeFile(join(cwd, ".ralph/skills/execute/SKILL.md"), "fallback");
  await mkdir(join(cwd, "custom/execute"), { recursive: true }); await writeFile(join(cwd, "custom/execute/SKILL.md"), "explicit");
  const result = discoverSkillConfig({ cwd, config: { skillDirs: ["custom"] } });
  assert.equal(result.skills.execute.text, "explicit"); assert.match(result.skills.execute.identity, /execute/);
});

test("malformed or oversized skills produce bounded diagnostics", async () => {
  const cwd = await mkdtemp("/tmp/prime-ralph-skills-"); await mkdir(join(cwd, ".ralph/skills/plan"), { recursive: true });
  await writeFile(join(cwd, ".ralph/skills/plan/SKILL.md"), "x".repeat(128 * 1024 + 1));
  const result = discoverSkillConfig({ cwd }); assert.equal(result.skills.plan, undefined); assert.equal(result.diagnostics[0].code, "skill_read_failed"); assert.ok(result.diagnostics[0].message.length < 240);
});

test("phase selector prioritizes blocked and durable plan state", () => {
  assert.equal(selectPhase(), "design"); assert.equal(selectPhase({ specExists: true }), "plan"); assert.equal(selectPhase({ specExists: true, planExists: true }), "prepare");
  assert.equal(selectPhase({ specExists: true, planExists: true, cycleState: "executing" }), "execute"); assert.equal(selectPhase({ blocked: true }), "blocked"); assert.equal(selectPhase({ specExists: true, planExists: true, goalStatus: "complete" }), "handoff");
});
