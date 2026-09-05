import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatBlockedInjection, loadBlockedSkill, RESTORED_BLOCKED_GUIDANCE } from "../src/execution.js";
import { formatPrepareInjection, loadPrepareSkill } from "../src/reset-skill.js";

if (process.env.PRIME_RALPH_REAL_MODEL_ACCEPTANCE !== "1") { console.error("SKIP: set PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 for real-model behavioral acceptance"); process.exit(2); }
const provider = process.env.PRIME_RALPH_ACCEPT_PROVIDER, model = process.env.PRIME_RALPH_ACCEPT_MODEL;
if (!provider || !model) throw new Error("PRIME_RALPH_ACCEPT_PROVIDER and PRIME_RALPH_ACCEPT_MODEL are required");
if (process.argv.some((value) => /api[-_]?key/i.test(value))) throw new Error("API keys are not accepted by this harness");
const root = fileURLToPath(new URL("..", import.meta.url)), args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const variantOption = option("--variant", "all"), variants = variantOption === "all" ? ["default", "beads"] : [variantOption];
if (variants.some((value) => !["default", "beads"].includes(value))) throw new Error("--variant must be default, beads, or all");
const artifactPath = resolve(option("--artifact", join(root, "docs/acceptance/blocked-recovery-model-acceptance.json")));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function assistantMessages(records) { return records.filter((record) => record.type === "message_end" && record.message?.role === "assistant").map((record) => record.message); }
function textOf(message) { return (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"); }
function toolCalls(messages) { return messages.flatMap((message) => (message.content ?? []).filter((part) => part.type === "toolCall")); }
const versionRun = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--version"], { encoding: "utf8", timeout: 10000 });
if (versionRun.status !== 0) throw new Error("cannot determine Prime Agent version");
const primeAgentVersion = (versionRun.stdout || versionRun.stderr).trim(), results = [];
for (const variant of variants) {
  const cwd = mkdtempSync(join(tmpdir(), `prime-ralph-blocked-model-${variant}-`)), auditPath = join(cwd, "audit.jsonl");
  for (const dir of [".ralph/skills/prepare", ".ralph/skills/blocked", ".ralph/plans"]) mkdirSync(join(cwd, dir), { recursive: true });
  cpSync(join(root, "templates", variant, "prepare", "SKILL.md"), join(cwd, ".ralph/skills/prepare/SKILL.md"));
  cpSync(join(root, "templates", variant, "blocked", "SKILL.md"), join(cwd, ".ralph/skills/blocked/SKILL.md"));
  writeFileSync(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# Synthetic restored specification\n\nThe provider login is required.\n");
  writeFileSync(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# Synthetic restored plan\n\nBlocked until the provider login is restored.\n");
  const extensionPath = join(cwd, "acceptance-tools.mjs");
  writeFileSync(extensionPath, `import { appendFileSync, readFileSync } from "node:fs";\nimport { join } from "node:path";\nconst audit = ${JSON.stringify(auditPath)};\nconst record = (value) => appendFileSync(audit, JSON.stringify(value) + "\\n");\nconst empty = { type: "object", properties: {}, additionalProperties: false };\nexport default function (pi) {\n  pi.registerTool({ name: "read_recovery_documents", label: "Read recovery documents", description: "Read the exact active specification and plan and report the synthetic unblock check.", parameters: empty, async execute(_id, _args, _signal, _update, ctx) { record({ name: "read_recovery_documents" }); return { content: [{ type: "text", text: JSON.stringify({ specification: readFileSync(join(ctx.cwd, ".ralph/plans/SPECIFICATION.md"), "utf8"), plan: readFileSync(join(ctx.cwd, ".ralph/plans/EXECUTION_PLAN.md"), "utf8"), verification: "A bounded synthetic provider-login probe passed. The provider login is restored." }) }] }; } });\n  pi.registerTool({ name: "ralph_lifecycle", label: "Ralph lifecycle", description: "Inspect or finish the synthetic blocked recovery.", parameters: { type: "object", properties: { action: { type: "string", enum: ["status", "confirm-forward", "unblock"] }, provenanceId: { type: "string" } }, required: ["action"], additionalProperties: false }, executionMode: "sequential", async execute(_id, args) { record({ name: "ralph_lifecycle", action: args.action, hasCurrentIdentifier: args.provenanceId === "synthetic-blocked-work" }); if (args.action === "status") return { content: [{ type: "text", text: "Ralph is resolving blocked work.\\nRecorded blocker: provider login is missing\\nCondition required before execution can restart: provider login is restored" }] }; if (args.action === "confirm-forward" && args.provenanceId === "synthetic-blocked-work") return { content: [{ type: "text", text: "The planning files are verified and the original blocker is resolved. Ralph remains stopped until the user runs /execute." }] }; return { content: [{ type: "text", text: "That action is not valid for these already-restored files." }], isError: true }; } });\n}\n`);
  const prompt = `${formatPrepareInjection(loadPrepareSkill({ cwd }))}\n${formatBlockedInjection(loadBlockedSkill({ cwd }), { mode: "blocked-restored", provenanceId: "synthetic-blocked-work" })}\n<prime-ralph-restored-guidance>${RESTORED_BLOCKED_GUIDANCE}</prime-ralph-restored-guidance>\n<synthetic-user-update>I restored the provider login. Use the available tools to inspect the original blocker, read the restored planning documents, verify the condition, and finish the safe recovery. Do not start execution.</synthetic-user-update>`;
  const run = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--mode", "json", "--provider", provider, "--model", model, "--thinking", "off", "--offline", "--extension", extensionPath, "--tools", "read_recovery_documents,ralph_lifecycle", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--cwd", cwd, "--system-prompt", "You are running a synthetic prime-ralph blocked-recovery acceptance. Follow the injected prepare and blocked instructions. Use both available tools. Confirm recovery only after the recorded condition and the restored files prove it. Do not expose internal identifiers or start execution.", "--", prompt], { encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024, env: process.env });
  const records = run.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), messages = assistantMessages(records), calls = toolCalls(messages), finalText = textOf(messages.at(-1));
  const audit = existsSync(auditPath) ? readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const statusIndex = audit.findIndex((item) => item.name === "ralph_lifecycle" && item.action === "status"), readIndex = audit.findIndex((item) => item.name === "read_recovery_documents"), confirmIndex = audit.findIndex((item) => item.name === "ralph_lifecycle" && item.action === "confirm-forward" && item.hasCurrentIdentifier), unblock = audit.some((item) => item.action === "unblock");
  const assertions = {
    processPassed: run.status === 0,
    inspectedStatus: statusIndex >= 0,
    readRestoredDocuments: readIndex >= 0,
    confirmedAfterEvidence: confirmIndex > statusIndex && confirmIndex > readIndex,
    didNotUnblockAgain: !unblock,
    finalExplainsStoppedState: /\/execute/i.test(finalText) && /stopped|not.*start|when.*ready/i.test(finalText),
    finalAvoidsInternalJargon: !/provenance|forwardConfirmed|lifecycleId/i.test(finalText),
  };
  results.push({ variant, provider, model, primeAgentVersion, promptSha256: sha256(prompt), toolSequence: audit, finalResponse: finalText, assertions, verdict: Object.values(assertions).every(Boolean) ? "pass" : "fail", exitStatus: run.status });
}
const artifact = { schemaVersion: 1, generatedAt: new Date().toISOString(), results };
const serialized = JSON.stringify(artifact, null, 2), secretPatterns = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:sk|pk)_[A-Za-z0-9_-]{20,}\b/, /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/];
if (secretPatterns.some((pattern) => pattern.test(serialized))) throw new Error("curated artifact rejected for secret shape");
mkdirSync(resolve(artifactPath, ".."), { recursive: true }); writeFileSync(artifactPath, `${serialized}\n`);
if (results.some((result) => result.verdict !== "pass")) { console.error(JSON.stringify(artifact, null, 2)); process.exit(1); }
console.log(JSON.stringify({ artifactPath, results: results.map(({ variant, verdict, assertions }) => ({ variant, verdict, assertions })) }, null, 2));
