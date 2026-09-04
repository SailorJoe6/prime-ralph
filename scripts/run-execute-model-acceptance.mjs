import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.PRIME_RALPH_REAL_MODEL_ACCEPTANCE !== "1") { console.error("SKIP: set PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1"); process.exit(2); }
const provider = process.env.PRIME_RALPH_ACCEPT_PROVIDER, model = process.env.PRIME_RALPH_ACCEPT_MODEL;
if (!provider || !model) throw new Error("PRIME_RALPH_ACCEPT_PROVIDER and PRIME_RALPH_ACCEPT_MODEL are required");
const root = fileURLToPath(new URL("..", import.meta.url)), cwd = mkdtempSync(join(tmpdir(), "prime-ralph-execute-model-"));
for (const dir of [".ralph/skills", ".ralph/plans/blocked", ".ralph/plans/archive", ".ralph/logs", ".prime/agent/extensions"]) mkdirSync(join(cwd, dir), { recursive: true });
for (const skill of ["prepare", "spec-it-out", "plan", "execute", "blocked"]) { mkdirSync(join(cwd, `.ralph/skills/${skill}`), { recursive: true }); cpSync(join(root, "templates/default", skill, "SKILL.md"), join(cwd, `.ralph/skills/${skill}/SKILL.md`)); }
symlinkSync(join(root, "src"), join(cwd, ".prime/agent/extensions/prime-ralph"), "dir");
writeFileSync(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# Specification\n\nCreate `artifact.txt` containing exactly `slice-5-public-goal-path\\n`. Add `test.mjs` using node:test that verifies the exact content. Run the test. Do not use the network. Completion requires both files and a passing test.\n");
writeFileSync(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# Execution plan\n\n## Slice 1\n\nCreate the artifact and its exact-content test, run `node --test test.mjs`, then complete the Ralph lifecycle without archive.\n");
const before = new Set(readdirSync(cwd)), started = Date.now();
const run = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--mode", "json", "--provider", provider, "--model", model, "--thinking", "off", "--offline", "--tools", "ipython,ralph_lifecycle", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--cwd", cwd, "--system-prompt", "You are running controlled prime-ralph execution acceptance. Obey the injected prepare and execute skills. Use ipython with await bash(...) for filesystem work and tests. Use the public pre-imported goal module exactly as the execute skill directs. Complete this small fixture and the Ralph lifecycle; do not do unrelated work.", "--", "/execute"], { encoding: "utf8", timeout: 240_000, maxBuffer: 32 * 1024 * 1024, env: process.env });
if (run.error) throw run.error;
const records = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const assistants = records.filter((record) => record.type === "message_end" && record.message?.role === "assistant").map((record) => record.message);
const calls = assistants.flatMap((message) => (message.content ?? []).filter((part) => part.type === "toolCall"));
const ipythonCode = calls.filter((call) => call.name === "ipython").map((call) => String(call.arguments?.code ?? "")).join("\n");
const artifact = existsSync(join(cwd, "artifact.txt")) ? readFileSync(join(cwd, "artifact.txt"), "utf8") : null;
const testFile = existsSync(join(cwd, "test.mjs")) ? readFileSync(join(cwd, "test.mjs"), "utf8") : null;
const log = existsSync(join(cwd, ".ralph/logs/EXECUTION_LOG.md")) ? readFileSync(join(cwd, ".ralph/logs/EXECUTION_LOG.md"), "utf8") : "";
const sessionFiles = [...readdirSync(cwd, { withFileTypes: true })].filter((entry) => entry.isDirectory() && entry.name === ".prime").length >= 0; // Session path is reported by JSON records, not fixed under the project.
const checks = {
  processSucceeded: run.status === 0 && !run.signal,
  artifactExact: artifact === "slice-5-public-goal-path\n",
  testCreated: typeof testFile === "string" && /node:test/.test(testFile),
  publicGoalCreateObserved: /goal\.create\s*\(/.test(ipythonCode),
  publicGoalCompleteObserved: /goal\.complete\s*\(/.test(ipythonCode),
  lifecycleCompleteObserved: calls.some((call) => call.name === "ralph_lifecycle" && call.arguments?.action === "complete"),
  completedPassLogged: /phase=execute/.test(log) && /artifact|test|slice-5/i.test(log),
  noArchive: existsSync(join(cwd, ".ralph/plans/SPECIFICATION.md")) && existsSync(join(cwd, ".ralph/plans/EXECUTION_PLAN.md")),
  providerObserved: assistants.some((message) => message.provider === provider),
  modelObserved: assistants.some((message) => message.model === model || message.responseModel === model),
};
const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
const result = { schemaVersion: 1, evidenceKind: "real-model-public-goal-execution", generatedAt: new Date().toISOString(), provider, model, durationMs: Date.now() - started, cwd, checks, observed: { status: run.status, signal: run.signal, toolCalls: calls.map((call) => call.name), finalAssistantText: assistants.at(-1)?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "" } };
const artifactDir = resolve(process.argv.includes("--artifact-dir") ? process.argv[process.argv.indexOf("--artifact-dir") + 1] : join(root, "docs/acceptance")); mkdirSync(artifactDir, { recursive: true });
const serialized = JSON.stringify(result, null, 2) + "\n"; if (/\b(?:sk|pk)_[A-Za-z0-9_-]{20,}\b|Bearer\s+[A-Za-z0-9._~+\/-]{16,}/i.test(serialized)) throw new Error("secret-shaped output rejected");
writeFileSync(join(artifactDir, "execute-model-acceptance.json"), serialized);
console.log(JSON.stringify({ artifactPath: join(artifactDir, "execute-model-acceptance.json"), checks, failures }, null, 2));
if (failures.length) process.exit(1);
