import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticSnapshot, isCompatiblePrimeAgent } from "../src/diagnostics.js";
test("compatibility gate accepts the validated Prime Agent version only", () => { assert.equal(isCompatiblePrimeAgent("0.9.1"), true); assert.equal(isCompatiblePrimeAgent("0.9.1+local"), true); assert.equal(isCompatiblePrimeAgent("0.9.0"), false); assert.equal(isCompatiblePrimeAgent("0.10.0"), false); });
test("diagnostic snapshot is bounded and excludes arbitrary state", () => { const s = diagnosticSnapshot({ primeAgentVersion: "0.9.1", state: { state: "reset", cycleId: 3, secret: "x" } }); assert.deepEqual(s, { plugin: "prime-ralph", version: "0.1.0", primeAgentVersion: "0.9.1", state: { state: "reset", cycleId: 3 } }); assert.doesNotMatch(JSON.stringify(s), /secret/); });
