import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const file of ["src/reset-extension.js", "src/workflow-extension.js"]) {
  test(`${file} has no successful provider-context rewrite`, () => {
    const source = readFileSync(join(root, file), "utf8");
    const returns = [...source.matchAll(/return\s*\{\s*messages:\s*([^}]+)\}/g)];
    assert.ok(returns.length > 0, "the fail-closed abort paths should remain explicit");
    for (const match of returns) {
      assert.equal(match[1].trim(), "[]", `unexpected successful context rewrite: ${match[1].trim()}`);
      const preceding = source.slice(Math.max(0, match.index - 1200), match.index);
      assert.match(preceding, /ctx\.abort\(\)/, "an empty context return must abort the provider request");
    }
    assert.doesNotMatch(source, /projectResetContext|blockedContextBoundary|projection-fallback/);
  });
}

test("obsolete projection POCs and helpers are not shipped", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.exports["./ralph-context"], undefined);
  assert.equal(packageJson.exports["./ralph-context-extension"], undefined);
  assert.equal(Object.keys(packageJson.exports).some((key) => key.includes("poc") || key.includes("observability") || key === "./ralph-extension"), false);
  assert.equal(Object.keys(packageJson.scripts).some((key) => key.startsWith("poc:")), false);
  for (const file of [
    "src/observability.js",
    "src/observability-extension.js",
    "src/cycle-boundary-poc.js",
    "src/cycle-coordinator.js",
    "src/continuation-adapter.js",
    "src/skill-config.js",
    "src/phase-runtime.js",
    "src/beads-coordination.js",
    "src/coordination-runtime.js",
    "src/bd-cli-adapter.js",
    "src/goal-lifecycle.js",
    "src/cache-analysis.js",
    "src/diagnostics.js",
    "src/ralph-extension.js",
    "src/ralph-context.js",
    "src/ralph-context-extension.js",
    "src/execution-boundary-compaction.js",
    "scripts/analyze-compaction-continuation.mjs",
    "scripts/run-agent-loop-poc.mjs",
    "scripts/run-agent-session-cancellation-poc.mjs",
    "scripts/run-agent-session-compaction-poc.mjs",
    "scripts/run-agent-session-continuation-poc.mjs",
    "scripts/run-agent-session-factory-poc.mjs",
    "scripts/run-agent-session-goal-coexistence-poc.mjs",
    "scripts/run-agent-session-multi-cycle-poc.mjs",
    "scripts/run-agent-session-provider-error-poc.mjs",
    "scripts/run-first-kept-poc.mjs",
    "scripts/run-mode-matrix-poc.mjs",
    "scripts/run-reset-compaction-poc.mjs",
    "docs/research-slice-2.md"
]) assert.equal(existsSync(join(root, file)), false, `${file} must stay removed`);
});

test("only legacy read compatibility may retain projection-consumed", () => {
  const execution = readFileSync(join(root, "src/execution.js"), "utf8");
  assert.match(execution, /EXECUTION_BOUNDARY_STAGES.*projection-consumed/);
  assert.doesNotMatch(execution, /function\s+.*project|blockedContextBoundary/);
});
