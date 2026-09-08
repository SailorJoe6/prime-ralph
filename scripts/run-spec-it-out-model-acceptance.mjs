import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatSpecificationInjection, loadSpecItOutSkill } from "../src/specification.js";

if (process.env.PRIME_RALPH_REAL_MODEL_ACCEPTANCE !== "1") {
  console.error("SKIP: set PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 for real-model behavioral acceptance");
  process.exit(2);
}
const provider = process.env.PRIME_RALPH_ACCEPT_PROVIDER, model = process.env.PRIME_RALPH_ACCEPT_MODEL;
if (!provider || !model) throw new Error("PRIME_RALPH_ACCEPT_PROVIDER and PRIME_RALPH_ACCEPT_MODEL are required");
if (process.argv.some((value) => /api[-_]?key/i.test(value))) throw new Error("API keys are not accepted by this harness");
const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const variantOption = option("--variant", "all"), caseOption = option("--case", "all");
const artifactDir = resolve(option("--artifact-dir", join(root, "docs/acceptance")));
const variants = variantOption === "all" ? ["default", "beads"] : [variantOption];
const caseNames = ["new", "existing", "future", "update", "cancel", "reset-existing"];
const cases = caseOption === "all" ? caseNames : [caseOption];
if (variants.some((value) => !["default", "beads"].includes(value))) throw new Error("--variant must be default, beads, or all");
if (cases.some((value) => !caseNames.includes(value))) throw new Error(`--case must be ${caseNames.join(", ")}, or all`);
mkdirSync(artifactDir, { recursive: true });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const secretPatterns = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:sk|pk)_[A-Za-z0-9_-]{20,}\b/, /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/];
function assertSafe(value, label) { if (secretPatterns.some((pattern) => pattern.test(value))) throw new Error(`${label} rejected for secret shape`); }
function manifest(directory, base = directory, output = {}) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), rel = relative(base, path), stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { output[rel] = { kind: "directory" }; manifest(path, base, output); }
    else if (stat.isFile()) output[rel] = { kind: "file", bytes: stat.size, sha256: sha256(readFileSync(path)) };
    else output[rel] = { kind: stat.isSymbolicLink() ? "symlink" : "other" };
  }
  return output;
}
function changedPaths(before, after) { return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort(); }
function samePaths(actual, expected) { return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()); }
function assistantMessages(records) { return records.filter((record) => record.type === "message_end" && record.message?.role === "assistant").map((record) => record.message); }
function textOf(message) { return (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"); }
function toolCalls(messages) { return messages.flatMap((message) => (message.content ?? []).filter((part) => part.type === "toolCall")); }
const initialUser = "I want to discuss better export errors, but I have not decided whether this belongs in the active specification or future work. Do not choose on my behalf.";
const choiceMenu = "An active specification already exists. Choose: 1. create a future specification after explicit confirmation; 2. discuss and update the active specification after explicit agreement; 3. cancel without changes.";
const definitions = {
  new: { mode: "specification-new", turns: [{ role: "user", text: "Create a specification for Orbit Ledger, a local CLI. It reads input.csv, writes JSON to standard output, never uses the network, and exits with code 2 when any input row is invalid. These decisions are final. Write the agreed specification now." }] },
  existing: { mode: "specification-existing", turns: [{ role: "user", text: initialUser }] },
  future: { mode: "specification-existing", turns: [{ role: "user", text: initialUser }, { role: "assistant", text: choiceMenu }, { role: "user", text: "I choose option 1 and explicitly confirm a future specification named export-errors. It should require a machine-readable error object on standard error. Create it now." }] },
  update: { mode: "specification-existing", turns: [{ role: "user", text: initialUser }, { role: "assistant", text: choiceMenu }, { role: "user", text: "I choose option 2. We discussed it, and I explicitly agree to update the active specification in place with a requirement for a machine-readable error object on standard error. Update it now." }] },
  cancel: { mode: "specification-existing", turns: [{ role: "user", text: initialUser }, { role: "assistant", text: choiceMenu }, { role: "user", text: "I choose option 3. Cancel without changing or creating any specification." }] },
  "reset-existing": { mode: "specification-reset-existing", turns: [{ role: "user", text: "The prior source conversation was cleared by the reset." }] },
};
const versionRun = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--version"], { encoding: "utf8", timeout: 10_000 });
if (versionRun.status !== 0) throw new Error("cannot determine Prime Agent version");
const primeAgentVersion = (versionRun.stdout || versionRun.stderr).trim();
const results = [];
for (const variant of variants) for (const caseName of cases) {
  const definition = definitions[caseName], cwd = mkdtempSync(join(tmpdir(), `prime-ralph-model-${variant}-${caseName}-`));
  mkdirSync(join(cwd, ".ralph/skills/spec-it-out"), { recursive: true }); mkdirSync(join(cwd, ".ralph/plans"), { recursive: true });
  cpSync(join(root, "templates", variant, "spec-it-out", "SKILL.md"), join(cwd, ".ralph/skills/spec-it-out/SKILL.md"));
  if (variant === "beads") { mkdirSync(join(cwd, ".beads")); writeFileSync(join(cwd, ".beads/sentinel"), "unchanged\n"); }
  if (caseName !== "new") writeFileSync(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# Existing specification\n\nCurrent export behavior is stable.\n");
  const toolExtension = join(cwd, "acceptance-tool.mjs");
  writeFileSync(toolExtension, `import { closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nfunction parents(ctx) { const values = [join(ctx.cwd, ".ralph"), join(ctx.cwd, ".ralph/plans")]; for (const value of values) { const stat = lstatSync(value); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe specification parent"); } }\nfunction result(path) { return { content: [{ type: "text", text: \`Wrote \${path}\` }], details: { written: true } }; }\nconst parameters = { type: "object", properties: { content: { type: "string", minLength: 1, maxLength: 65536 } }, required: ["content"], additionalProperties: false };\nexport default function (pi) {\npi.registerTool({ name: "write_specification", label: "Write active specification", description: "Exclusively create the exact active specification when it is absent.", parameters, async execute(_id, { content }, _signal, _update, ctx) { parents(ctx); const path = join(ctx.cwd, ".ralph/plans/SPECIFICATION.md"), fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, content, "utf8"); } finally { closeSync(fd); } return result(".ralph/plans/SPECIFICATION.md"); } });\npi.registerTool({ name: "write_future_specification", label: "Write confirmed future specification", description: "Create the explicitly confirmed future specification at .ralph/plans/future/export-errors/SPECIFICATION.md without changing the active specification.", parameters, async execute(_id, { content }, _signal, _update, ctx) { parents(ctx); const future = join(ctx.cwd, ".ralph/plans/future"); if (!existsSync(future)) mkdirSync(future); const futureStat = lstatSync(future); if (futureStat.isSymbolicLink() || !futureStat.isDirectory()) throw new Error("unsafe future parent"); const directory = join(future, "export-errors"); mkdirSync(directory); const path = join(directory, "SPECIFICATION.md"), fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, content, "utf8"); } finally { closeSync(fd); } return result(".ralph/plans/future/export-errors/SPECIFICATION.md"); } });\npi.registerTool({ name: "update_active_specification", label: "Update explicitly approved active specification", description: "Atomically replace the exact active specification after explicit in-place agreement.", parameters, async execute(_id, { content }, _signal, _update, ctx) { parents(ctx); const path = join(ctx.cwd, ".ralph/plans/SPECIFICATION.md"), stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe active specification"); const temporary = join(ctx.cwd, ".ralph/plans/.SPECIFICATION.acceptance-tmp"); const fd = openSync(temporary, "wx", 0o600); try { writeFileSync(fd, content, "utf8"); closeSync(fd); renameSync(temporary, path); } catch (error) { try { closeSync(fd); } catch {} rmSync(temporary, { force: true }); throw error; } return result(".ralph/plans/SPECIFICATION.md"); } });\n}\n`);
  const skillPath = join(cwd, ".ralph/skills/spec-it-out/SKILL.md"), skillText = readFileSync(skillPath, "utf8");
  const injection = formatSpecificationInjection(loadSpecItOutSkill({ cwd }), definition.mode);
  const orderedTurns = [...definition.turns]; orderedTurns.splice(1, 0, { role: "plugin", text: injection });
  const prompt = `Continue from this ordered provider-visible conversation. The plugin turn is authoritative and its skill remains in force.\n\n${orderedTurns.map((turn) => `<${turn.role}>\n${turn.text}\n</${turn.role}>`).join("\n")}`;
  const baseline = manifest(cwd), startedAt = new Date(), started = Date.now();
  const run = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--mode", "json", "--provider", provider, "--model", model, "--thinking", "low", "--no-session", "--offline", "--no-builtin-tools", "--tools", "write_specification,write_future_specification,update_active_specification", "--no-extensions", "-e", toolExtension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--cwd", cwd, "--system-prompt", "You are running controlled prime-ralph prompt acceptance. Continue the supplied ordered conversation. Follow the plugin invocation and canonical skill. Use only the narrow offered tool for an explicitly authorized document action. Do not implement, plan, or execute the described project.", "--", prompt], { encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: process.env });
  if (run.error) throw run.error;
  if (Buffer.byteLength(run.stdout) >= 4 * 1024 * 1024) throw new Error(`${variant}/${caseName}: JSON output exceeded cap`);
  const records = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const messages = assistantMessages(records), calls = toolCalls(messages), finalMessage = messages.at(-1), finalText = textOf(finalMessage);
  const activePath = join(cwd, ".ralph/plans/SPECIFICATION.md"), activeExists = existsSync(activePath), activeContent = activeExists ? readFileSync(activePath, "utf8") : "";
  const futurePath = join(cwd, ".ralph/plans/future/export-errors/SPECIFICATION.md"), futureExists = existsSync(futurePath), futureContent = futureExists ? readFileSync(futurePath, "utf8") : "";
  const after = manifest(cwd), changed = changedPaths(baseline, after), assertions = [];
  const check = (name, pass) => assertions.push({ name, pass: Boolean(pass) });
  check("process succeeded", run.status === 0 && !run.signal); check("Prime Agent 0.9.3 recorded", primeAgentVersion === "0.9.3");
  check("terminal assistant response", finalMessage && !["error", "aborted", "length"].includes(finalMessage.stopReason));
  check("selected provider observed", messages.every((message) => message.provider === provider)); check("selected model observed", messages.every((message) => message.model === model || message.responseModel === model));
  check("no planning or execution artifact", !existsSync(join(cwd, ".ralph/plans/EXECUTION_PLAN.md")));
  const activeUnchanged = after[".ralph/plans/SPECIFICATION.md"]?.sha256 === baseline[".ralph/plans/SPECIFICATION.md"]?.sha256;
  if (caseName === "new") {
    check("one active creation call", calls.length === 1 && calls[0].name === "write_specification"); check("exact active specification created", activeExists && activeContent.trim().length > 0);
    check("all agreed decisions captured", [/input\.csv/i, /JSON/i, /network/i, /(?:exit|code).*2|2.*(?:exit|code)/i].every((pattern) => pattern.test(activeContent)));
    check("only active specification changed", samePaths(changed, [".ralph/plans/SPECIFICATION.md"]));
  } else if (caseName === "existing") {
    check("no mutation call", calls.length === 0); check("active specification unchanged", activeUnchanged); check("no fixture files changed", changed.length === 0);
    check("warns active specification exists", /active specification.*(?:exists|already)|already.*active specification/i.test(finalText)); check("offers future specification", /future specification|\.ralph\/plans\/future\//i.test(finalText));
    check("offers active discussion or update", /discuss|update|edit/i.test(finalText)); check("offers cancellation", /cancel|leave.*unchanged|no changes/i.test(finalText)); check("offers three choices", /(?:1[.)]|one).*?(?:2[.)]|two).*?(?:3[.)]|three)/is.test(finalText));
  } else if (caseName === "future") {
    check("one future creation call", calls.length === 1 && calls[0].name === "write_future_specification"); check("active specification unchanged", activeUnchanged);
    check("future specification created", futureExists && /machine-readable error object|standard error/i.test(futureContent));
    check("only confirmed future tree changed", samePaths(changed, [".ralph/plans/future", ".ralph/plans/future/export-errors", ".ralph/plans/future/export-errors/SPECIFICATION.md"]));
  } else if (caseName === "update") {
    check("one active update call", calls.length === 1 && calls[0].name === "update_active_specification"); check("active specification changed", !activeUnchanged && /machine-readable error object|standard error/i.test(activeContent));
    check("only active specification changed", samePaths(changed, [".ralph/plans/SPECIFICATION.md"]));
  } else if (caseName === "cancel") {
    check("cancel performs no tool call", calls.length === 0); check("active specification unchanged", activeUnchanged); check("cancel changes no files", changed.length === 0);
  } else {
    check("reset-existing performs no tool call", calls.length === 0); check("active specification unchanged", activeUnchanged); check("reset-existing changes no files", changed.length === 0);
    check("offers active discussion or update", /discuss|update|edit/i.test(finalText)); check("offers cancellation", /cancel|leave.*unchanged|no changes/i.test(finalText)); check("does not offer future specification", !/future specification|\.ralph\/plans\/future\//i.test(finalText));
  }
  if (variant === "beads") check("Beads state unchanged", after[".beads/sentinel"]?.sha256 === baseline[".beads/sentinel"]?.sha256 && !/(?:created|closed).*(?:issue|bead)|(?:issue|bead).*(?:created|closed)/i.test(finalText));
  assertSafe(finalText, `${variant}/${caseName} response`); assertSafe(activeContent, `${variant}/${caseName} active specification`); assertSafe(futureContent, `${variant}/${caseName} future specification`);
  const result = { schemaVersion: 2, evidenceKind: "real-model-behavioral", variant, case: caseName, invocation: { specificationState: caseName === "new" ? "absent" : "existing", invocationMode: definition.mode }, fixtureConversation: definition.turns, prompt: { repositoryPath: `templates/${variant}/spec-it-out/SKILL.md`, sha256: sha256(skillText) }, runtime: { primeAgentVersion, primeRalphVersion: packageJson.version, nodeVersion: process.version, requestedProvider: provider, requestedModel: model }, observed: { provider: finalMessage?.provider, model: finalMessage?.model, responseModel: finalMessage?.responseModel, stopReason: finalMessage?.stopReason, usage: finalMessage?.usage, toolCalls: calls.map((call) => call.name), finalAssistantText: finalText }, files: { changed, afterManifest: after, activeSpecification: activeExists ? { bytes: Buffer.byteLength(activeContent), sha256: sha256(activeContent), content: activeContent } : null, futureSpecification: futureExists ? { bytes: Buffer.byteLength(futureContent), sha256: sha256(futureContent), content: futureContent } : null }, timing: { startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - started }, assertions, verdict: assertions.every((assertion) => assertion.pass) ? "pass" : "fail" };
  results.push(result);
}
const artifact = { schemaVersion: 2, evidenceKind: "real-model-behavioral", generatedAt: new Date().toISOString(), provider, model, results };
const serialized = JSON.stringify(artifact, null, 2) + "\n"; assertSafe(serialized, "artifact");
const artifactPath = join(artifactDir, "spec-it-out-model-acceptance.json"); writeFileSync(artifactPath, serialized);
const failed = results.filter((result) => result.verdict !== "pass");
console.log(JSON.stringify({ artifactPath, cases: results.length, passed: results.length - failed.length, failed: failed.map((result) => ({ variant: result.variant, case: result.case, assertions: result.assertions.filter((item) => !item.pass).map((item) => item.name) })) }, null, 2));
if (failed.length) process.exit(1);
