import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const PHASES = ["design", "plan", "execute", "handoff", "prepare", "blocked"];
const MAX_SKILL_BYTES = 128 * 1024;

export function discoverSkillConfig({ cwd = process.cwd(), config = {}, env = process.env } = {}) {
  const roots = [];
  if (Array.isArray(config.skillDirs)) roots.push(...config.skillDirs.map((p) => resolve(cwd, p)));
  if (env.PRIME_RALPH_SKILL_DIR) roots.push(resolve(cwd, env.PRIME_RALPH_SKILL_DIR));
  roots.push(resolve(cwd, ".prime-ralph/skills"), resolve(cwd, ".ralph/skills"));
  const diagnostics = [];
  const unique = [...new Set(roots)];
  const skills = {};
  for (const phase of PHASES) {
    const candidates = unique.flatMap((root) => [join(root, phase, "SKILL.md"), join(root, `${phase}.md`)]);
    const path = candidates.find((candidate) => existsSync(candidate) && statSafe(candidate));
    if (!path) continue;
    try {
      const text = readFileSync(path, "utf8");
      if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new Error(`skill exceeds ${MAX_SKILL_BYTES} bytes`);
      skills[phase] = { phase, path, text, identity: `${phase}:${path}` };
    } catch (error) { diagnostics.push({ code: "skill_read_failed", phase, path, message: String(error.message).slice(0, 200) }); }
  }
  return { skills, roots: unique, diagnostics };
}

export function selectPhase({ specExists = false, planExists = false, blocked = false, goalStatus = "active", cycleState = "idle" } = {}) {
  if (blocked || goalStatus === "blocked") return "blocked";
  if (goalStatus === "complete" || cycleState === "complete") return "handoff";
  if (!specExists) return "design";
  if (!planExists) return "plan";
  if (["idle", "preparing"].includes(cycleState)) return "prepare";
  return "execute";
}

function statSafe(path) { try { return statSync(path).isFile(); } catch { return false; } }
