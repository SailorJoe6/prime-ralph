import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../scripts/run-public-setup-discovery-acceptance.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("public setup discovery acceptance uses only a spawned supported host transport", () => {
  assert.match(packageJson.scripts["accept:public-setup-discovery"], /run-public-setup-discovery-acceptance\.mjs/);
  for (const forbidden of [
    "dist/core",
    "createAgentSession",
    "SessionManager",
    "discoverAndLoadExtensions",
    "prime-agent-private",
  ]) assert.equal(script.includes(forbidden), false, forbidden);
  assert.match(script, /spawnSync\(primeAgentBin/);
  assert.match(script, /"--mode", "rpc"/);
  assert.match(script, /type: "get_commands"/);
  assert.match(script, /command\.sourceInfo\?\.path === expectedEntry/);
  assert.match(script, /project command catalog mismatch/);
  assert.match(script, /realpathSync\(expectedEntry\)/);
  assert.match(script, /version !== "0\.9\.3"/);
  assert.match(script, /"--no-skills"/);
  assert.doesNotMatch(script, /--daemon-socket|shutdown/);
  assert.match(script, /abort was not acknowledged/);
  assert.match(script, /reported an extension load error/);
});

test("public setup discovery acceptance isolates resources without daemon control", () => {
  for (const option of ["--offline", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]) {
    assert.match(script, new RegExp(`"${option}"`));
  }
  assert.doesNotMatch(script, /HOME|XDG_|credentialKey|PRIME_AGENT_INTERNAL/);
  assert.match(script, /noProviderBehaviorClaimed: true/);
});
