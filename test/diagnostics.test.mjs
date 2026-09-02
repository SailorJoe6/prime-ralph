import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticSnapshot, isCompatiblePrimeAgent } from "../src/diagnostics.js";
test("compatibility gate accepts supported Prime Agent range only", () => { assert.equal(isCompatiblePrimeAgent("0.8.0"), true); assert.equal(isCompatiblePrimeAgent("0.9.0"), false); assert.equal(isCompatiblePrimeAgent("1.0.0"), false); });
test("diagnostic snapshot is bounded and excludes arbitrary state", () => { const s = diagnosticSnapshot({ primeAgentVersion: "0.8.0", state: { state: "execute", cycleId: 3, secret: "x" } }); assert.deepEqual(s, { plugin: "prime-ralph", version: "0.1.0", primeAgentVersion: "0.8.0", state: { state: "execute", cycleId: 3 } }); assert.doesNotMatch(JSON.stringify(s), /secret/); });
