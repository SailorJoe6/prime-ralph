import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli, runCli, USAGE } from "../src/cli.js";

function sink() { let text = ""; return { stream: { write(value) { text += value; } }, read: () => text }; }

test("CLI parses the exact initializer interface", () => {
  assert.deepEqual(parseCli(["init"]), { command: "init", options: {} });
  assert.deepEqual(parseCli(["init", "--project", "a path", "--beads", "--stealth"]), { command: "init", options: { project: "a path", beads: true, stealth: true } });
  assert.deepEqual(parseCli(["init", "--project=other"]), { command: "init", options: { project: "other" } });
  assert.deepEqual(parseCli(["--help"]), { help: true });
});

test("CLI rejects unknown commands, flags, missing values, and duplicates", () => {
  for (const argv of [["run"], ["init", "--unknown"], ["init", "--project"], ["init", "--project", "--beads"], ["init", "--beads", "--beads"], ["init", "--project=a", "--project=b"]]) {
    assert.throws(() => parseCli(argv));
  }
});

test("CLI help is side-effect free and init reports bounded results", () => {
  const out = sink(); const err = sink();
  assert.equal(runCli(["--help"], { stdout: out.stream, stderr: err.stream }), 0);
  assert.equal(out.read(), USAGE); assert.equal(err.read(), "");
  const missing = join(mkdtempSync(join(tmpdir(), "prime-ralph-cli-")), "missing");
  const code = runCli(["init", "--project", missing], { stdout: out.stream, stderr: err.stream });
  assert.equal(code, 1); assert.match(err.read(), /Project path is not a directory/);
});
