import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli, runCli, USAGE } from "../src/cli.js";

function sink() { let text = ""; return { stream: { write(value) { text += value; } }, read: () => text }; }

test("CLI parses the exact initializer interface", () => {
  assert.deepEqual(parseCli(["init"]), { command: "init", options: {} });
  assert.deepEqual(parseCli(["init", "--project", "a path", "--beads", "--stealth"]), { command: "init", options: { project: "a path", beads: true, stealth: true } });
  assert.deepEqual(parseCli(["init", "--project=other"]), { command: "init", options: { project: "other" } });
  assert.deepEqual(parseCli(["recover", "--project", "a path"]), { command: "recover", options: { project: "a path" } });
  assert.deepEqual(parseCli(["--help"]), { help: true });
});

test("CLI rejects unknown commands, flags, missing values, and duplicates", () => {
  for (const argv of [["run"], ["init", "--unknown"], ["init", "--project"], ["init", "--project", "--beads"], ["init", "--beads", "--beads"], ["init", "--project=a", "--project=b"], ["recover", "--beads"], ["recover", "--stealth"], ["recover", "--project=a", "--project=b"]]) {
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
test("CLI reports bounded legacy skill-link migration", () => {
  const cwd = mkdtempSync(join(tmpdir(), "prime-ralph-cli-migration-"));
  const initialOut = sink(); const initialErr = sink();
  assert.equal(runCli(["init", "--project", cwd], { stdout: initialOut.stream, stderr: initialErr.stream }), 0);
  mkdirSync(join(cwd, ".agents/skills"), { recursive: true });
  const link = join(cwd, ".agents/skills/spec-it-out");
  symlinkSync("../../.ralph/skills/spec-it-out", link, "dir");
  const out = sink(); const err = sink();
  assert.equal(runCli(["init", "--project", cwd], { stdout: out.stream, stderr: err.stream }), 0);
  assert.equal(existsSync(link), false);
  assert.match(out.read(), /removed legacy link: \.agents\/skills\/spec-it-out/);
  assert.equal(err.read(), "");
});


test("recover prints exact shell-safe no-extensions guidance and performs no initialization", () => {
  const out = sink(), err = sink(); let initialized = 0;
  const code = runCli(["recover", "--project", "/tmp/a b'c"], { stdout: out.stream, stderr: err.stream }, { initializeProject: () => { initialized += 1; throw new Error("must not run"); } });
  assert.equal(code, 0); assert.equal(initialized, 0); assert.equal(err.read(), "");
  assert.equal(out.read(), `Provider-free offline inspection (this command starts and changes nothing):
1. Stop the affected Prime Agent process.
2. Start a fresh native session in a separate shell:
   prime-agent --no-extensions --cwd '/tmp/a b'"'"'c'
3. Do not add --continue, --resume, or --fork.
4. Inspect the durable worktree, planning documents, Git state, and issue state before deciding whether to start new work.
`);
  assert.doesNotMatch(out.read(), /--continue .*prime-agent|--resume .*prime-agent|--fork .*prime-agent/);
});
