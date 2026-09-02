import test from "node:test";
import assert from "node:assert/strict";
import { BdCliAdapter } from "../src/bd-cli-adapter.js";

test("bd adapter uses argument arrays and parses JSON", async () => { const calls = []; const bd = new BdCliAdapter({ run: async (args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" }; } }); assert.deepEqual(await bd.show("issue-1"), { ok: true }); await bd.claim("issue-1"); await bd.checkpoint("issue-1", "tests passed"); await bd.close("issue-1", "done"); assert.deepEqual(calls, [["show", "issue-1", "--json"], ["update", "issue-1", "--claim", "--json"], ["update", "issue-1", "--append-notes", "tests passed", "--json"], ["close", "issue-1", "--reason", "done", "--json"]]); });
test("bd adapter bounds failures and rejects invalid output", async () => { const bd = new BdCliAdapter({ run: async () => ({ code: 1, stderr: "secret token should not leak" }) }); await assert.rejects(() => bd.show("i"), /bd show failed/); const bad = new BdCliAdapter({ run: async () => ({ code: 0, stdout: "not-json" }) }); await assert.rejects(() => bad.show("i"), /invalid JSON/); });
