import test from "node:test";
import assert from "node:assert/strict";
import primeRalph from "../src/index.js";

test("exports the production Slice 5 workflow extension", () => {
  const commands = new Map(), handlers = new Map();
  const pi = { registerTool() {}, registerCommand(name, command) { commands.set(name, command); }, on(name, handler) { handlers.set(name, handler); }, appendEntry() {}, sendMessage() {} };
  assert.doesNotThrow(() => primeRalph(pi));
  assert.deepEqual([...commands.keys()], ["reset", "spec-it-out", "plan", "ralph-recover", "execute"]);
  assert.equal(handlers.has("context"), true);
});

test("does not shadow Prime Agent's built-in /clear command", () => {
  const commands = [];
  primeRalph({ registerTool() {}, registerCommand(name) { commands.push(name); }, on() {}, appendEntry() {}, sendMessage() {} });
  assert.equal(commands.includes("clear"), false);
});
