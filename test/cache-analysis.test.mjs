import test from "node:test";
import assert from "node:assert/strict";
import { cacheBoundaryReport, cycleSnapshots, longestCommonPrefixBytes, stablePrefixSnapshot } from "../src/cache-analysis.js";

test("stable prefix is byte-identical despite object key order", () => { const a = stablePrefixSnapshot({ systemPrompt: "R", tools: [{ z: 1, a: 2 }], ralphPrompt: "P" }); const b = stablePrefixSnapshot({ ralphPrompt: "P", tools: [{ a: 2, z: 1 }], systemPrompt: "R" }); assert.equal(a, b); });
test("dynamic suffix changes do not change measured prefix", () => { const prefix = stablePrefixSnapshot({ systemPrompt: "R", ralphPrompt: "P" }); const a = `${prefix}|completion-a`; const b = `${prefix}|completion-b`; assert.ok(longestCommonPrefixBytes(a, b) >= Buffer.byteLength(prefix) + 1); });
test("cache report distinguishes common prefix from cache hit billing", () => { const report = cacheBoundaryReport(["stable|a", "stable|b", "stable|c"]); assert.deepEqual(report, { count: 3, byteLengths: [8, 8, 8], commonPrefixBytes: 7 }); });

test("repeated cycles preserve stable prefix while changed state invalidates it", () => { const stable = stablePrefixSnapshot({ systemPrompt: "Ralph", ralphPrompt: "Read plan" }); const same = cycleSnapshots({ prefix: stable, completions: ["one", "two"] }); assert.equal(same[0].slice(0, stable.length), stable); assert.equal(same[1].slice(0, stable.length), stable); const changed = stablePrefixSnapshot({ systemPrompt: "Ralph", ralphPrompt: "Read changed plan" }); assert.notEqual(changed, stable); assert.ok(longestCommonPrefixBytes(stable, changed) < Buffer.byteLength(stable)); });

test("tool and model-setting changes invalidate the prefix", () => { const base = stablePrefixSnapshot({ systemPrompt: "R", tools: [{ name: "read" }], modelSettings: { model: "m1", thinking: "off" } }); assert.notEqual(base, stablePrefixSnapshot({ systemPrompt: "R", tools: [{ name: "write" }], modelSettings: { model: "m1", thinking: "off" } })); assert.notEqual(base, stablePrefixSnapshot({ systemPrompt: "R", tools: [{ name: "read" }], modelSettings: { model: "m2", thinking: "off" } })); });
