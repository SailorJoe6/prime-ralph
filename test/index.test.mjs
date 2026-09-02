import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import primeRalph from "../src/index.js";

test("exports a loadable Prime Agent extension factory", () => {
  assert.equal(typeof primeRalph, "function");
  assert.doesNotThrow(() => primeRalph({}));
});

test("slice 1 remains behavior-neutral", async () => {
  const source = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.js"), "utf8");
  assert.match(source, /Deliberately no-op/);
});
