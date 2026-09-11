import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizedPrimeAgentEnvironment } from "../scripts/public-acceptance-env.mjs";

const script = readFileSync(new URL("../scripts/run-public-reset-acceptance.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("public reset acceptance uses a spawned supported RPC boundary", () => {
  assert.match(packageJson.scripts["accept:public-reset"], /run-public-reset-acceptance\.mjs/);
  for (const forbidden of [
    "dist/core",
    "createAgentSession",
    "AgentSession",
    "SessionManager",
    "_extensionRunner",
    "_agentEventQueue",
    "_executeExtensionCommand",
    "node:readline",
  ]) assert.equal(script.includes(forbidden), false, forbidden);
  assert.match(script, /spawn\(primeAgentBin/);
  assert.match(script, /"--mode", "rpc"/);
  assert.match(script, /pi\.registerProvider/);
  assert.match(script, /server\.listen\(0, "127\.0\.0\.1"/);
  assert.match(script, /"--no-extensions"/);
  assert.match(script, /"--session-dir", sessionDir/);
  assert.match(script, /env: childEnv/);
  assert.match(script, /stdoutBuffer\.indexOf\("\\n"\)/);
  const requestValidation = script.indexOf('request.method !== "POST"');
  const admissionSnapshot = script.indexOf("const jsonlAtRequest =");
  const bodyRead = script.indexOf("for await (const chunk of request)");
  assert.ok(requestValidation >= 0 && requestValidation < admissionSnapshot);
  assert.ok(admissionSnapshot < bodyRead);
  assert.doesNotMatch(script, /--daemon-socket|prime-agent\s+(?:shutdown|stop)/);
});

test("spawned public acceptance removes inherited private worker capabilities", () => {
  const clean = sanitizedPrimeAgentEnvironment({
    PATH: "/fixture/bin",
    PRIME_AGENT_BIN: "/private/bin",
    PRIME_AGENT_INTERNAL_WORKER_TOKEN: "secret",
    PRIME_AGENT_INTERNAL_ACTIVE_SESSION_ID: "parent",
    PRIME_AGENT_KERNEL_OWNER_PID: "123",
    RLM_DEPTH: "1",
    RLM_SESSION_DIR: "/private/session",
    RLM_HARNESS_STATE_DIR: "/private/local",
    RLM_GLOBAL_HARNESS_STATE_DIR: "/private/global",
    RLM_MAX_DEPTH: "3",
  });
  assert.deepEqual(clean, { PATH: "/fixture/bin" });
});

test("public reset acceptance binds actual provider input to durable reset evidence", () => {
  for (const required of [
    "oneResetProviderRequest",
    "oneResetMarker",
    "oneResetCompaction",
    "oneResetBoundary",
    "oneCompletedReset",
    "requestIdentityBound",
    "durableOrdering",
    "markerAnchoredCompaction",
    "compactionEventsExact",
    "publicCompactionSettledBeforeProvider",
    "boundaryDurableBeforeProvider",
    "providerTranscriptEquivalent",
    "prepareExactlyOnce",
    "staleProviderContextExcluded",
    "sameSessionIdentity",
    "appendOnlyJsonl",
    "durableHistoryRetained",
    "publicMessagesMatchDurableBoundary",
  ]) assert.match(script, new RegExp(`${required}:`), required);
  assert.match(script, /checks\.defaultDaemonIdentityStable =/);
  assert.match(script, /snapshotMarkerIndex < snapshotCompactionIndex/);
  assert.match(script, /snapshotCompactionIndex < snapshotMessageIndex/);
  assert.match(script, /compactionEndObservation\.observedAt < resetObservation\.requestObservedAt/);
  assert.match(script, /transactionIds\.every\(\(id\) => id === resetRequestId\)/);
  assert.match(script, /transactionSessionIds\.every\(\(id\) => id === identityBefore\.sessionId\)/);
  assert.match(script, /jsonlAfter\.startsWith\(jsonlBefore\)/);
  assert.match(script, /JSON\.stringify\(providerMessages\) === JSON\.stringify\(expectedProviderMessages\)/);
  assert.match(script, /markerIndex < compactionIndex && compactionIndex < messageIndex && messageIndex < completedIndex/);
  assert.match(script, /providerBodies\.slice\(providerCallsBeforeReset\)/);
  assert.match(script, /resetProviderBodies\.length === 1/);
  assert.match(script, /split\(PREPARE_SENTINEL\)\.length - 1 === 1/);
});

test("public reset evidence remains narrow and deterministic", () => {
  assert.match(script, /evidenceKind: "public-spawned-reset-compaction"/);
  assert.match(script, /autoRefine: \{ enabled: false \}/);
  assert.match(script, /version !== PRIME_AGENT_VERSION/);
  assert.match(script, /"--offline"/);
  assert.match(script, /"--no-skills"/);
  assert.match(script, /"--no-prompt-templates"/);
  assert.match(script, /"--no-themes"/);
  assert.match(script, /"--no-context-files"/);
  assert.doesNotMatch(script, /reset-busy|reset-lifecycle|specification-workflow|planning-workflow/);
});
