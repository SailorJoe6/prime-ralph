import test from "node:test";
import assert from "node:assert/strict";
import { cacheBoundaryReport, longestCommonPrefixBytes, stablePrefixSnapshot } from "../src/cache-analysis.js";

test("stable prefix is byte-identical despite object key order", () => { const a = stablePrefixSnapshot({ systemPrompt: "R", tools: [{ z: 1, a: 2 }], ralphPrompt: "P" }); const b = stablePrefixSnapshot({ ralphPrompt: "P", tools: [{ a: 2, z: 1 }], systemPrompt: "R" }); assert.equal(a, b); });
test("dynamic suffix changes do not change measured prefix", () => { const prefix = stablePrefixSnapshot({ systemPrompt: "R", ralphPrompt: "P" }); const a = `${prefix}|completion-a`; const b = `${prefix}|completion-b`; assert.ok(longestCommonPrefixBytes(a, b) >= Buffer.byteLength(prefix) + 1); });
test("cache report distinguishes common prefix from cache hit billing", () => { const report = cacheBoundaryReport(["stable|a", "stable|b", "stable|c"]); assert.deepEqual(report, { count: 3, byteLengths: [8, 8, 8], commonPrefixBytes: 7 }); });
