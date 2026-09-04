import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatPlanningInjection, loadPlanSkill } from "../src/planning.js";

if (process.env.PRIME_RALPH_REAL_MODEL_ACCEPTANCE !== "1") { console.error("SKIP: set PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 for real-model behavioral acceptance"); process.exit(2); }
const provider = process.env.PRIME_RALPH_ACCEPT_PROVIDER, model = process.env.PRIME_RALPH_ACCEPT_MODEL;
if (!provider || !model) throw new Error("PRIME_RALPH_ACCEPT_PROVIDER and PRIME_RALPH_ACCEPT_MODEL are required");
if (process.argv.some((value) => /api[-_]?key/i.test(value))) throw new Error("API keys are not accepted by this harness");
const root = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2); function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const variantOption = option("--variant", "all"), caseOption = option("--case", "all"), artifactDir = resolve(option("--artifact-dir", join(root, "docs/acceptance")));
const variants = variantOption === "all" ? ["default", "beads"] : [variantOption];
const caseNames = ["new", "existing", "update", "cancel", "reset-new", "reset-existing"], cases = caseOption === "all" ? caseNames : [caseOption];
if (variants.some((value) => !["default", "beads"].includes(value))) throw new Error("--variant must be default, beads, or all");
if (cases.some((value) => !caseNames.includes(value))) throw new Error(`--case must be ${caseNames.join(", ")}, or all`);
mkdirSync(artifactDir, { recursive: true });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const secretPatterns = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:sk|pk)_[A-Za-z0-9_-]{20,}\b/, /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/];
function assertSafe(value, label) { if (secretPatterns.some((pattern) => pattern.test(value))) throw new Error(`${label} rejected for secret shape`); }
function manifest(directory, base = directory, output = {}) { for (const name of readdirSync(directory).sort()) { const path = join(directory, name), rel = relative(base, path), stat = lstatSync(path); if (stat.isDirectory() && !stat.isSymbolicLink()) { output[rel] = { kind: "directory" }; manifest(path, base, output); } else if (stat.isFile()) output[rel] = { kind: "file", bytes: stat.size, sha256: sha256(readFileSync(path)) }; else output[rel] = { kind: stat.isSymbolicLink() ? "symlink" : "other" }; } return output; }
function changedPaths(before, after) { return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort(); }
function assistantMessages(records) { return records.filter((record) => record.type === "message_end" && record.message?.role === "assistant").map((record) => record.message); }
function textOf(message) { return (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"); }
function toolCalls(messages) { return messages.flatMap((message) => (message.content ?? []).filter((part) => part.type === "toolCall")); }
const initialUser = "I want to review the active execution plan, but I have not approved any plan edit.";
const choiceMenu = "An active execution plan already exists. Choose whether to discuss it, explicitly agree to an in-place update, or cancel without changes.";
const definitions = {
  new: { mode: "planning-new", turns: [] },
  existing: { mode: "planning-existing", turns: [{ role: "user", text: initialUser }] },
  update: { mode: "planning-existing", turns: [{ role: "user", text: initialUser }, { role: "assistant", text: choiceMenu }, { role: "user", text: "We discussed it. I explicitly agree to update the active plan in place so it has exactly the two vertical slices required by the specification. Update it now." }] },
  cancel: { mode: "planning-existing", turns: [{ role: "user", text: initialUser }, { role: "assistant", text: choiceMenu }, { role: "user", text: "Cancel. Do not change the execution plan." }] },
  "reset-new": { mode: "planning-reset-new", turns: [] },
  "reset-existing": { mode: "planning-reset-existing", turns: [] },
};
const versionRun = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--version"], { encoding: "utf8", timeout: 10_000 });
if (versionRun.status !== 0) throw new Error("cannot determine Prime Agent version");
const primeAgentVersion = (versionRun.stdout || versionRun.stderr).trim(), results = [];
for (const variant of variants) for (const caseName of cases) {
  const definition = definitions[caseName], cwd = mkdtempSync(join(tmpdir(), `prime-ralph-plan-model-${variant}-${caseName}-`));
  mkdirSync(join(cwd, ".ralph/skills/plan"), { recursive: true }); mkdirSync(join(cwd, ".ralph/plans"), { recursive: true });
  cpSync(join(root, "templates", variant, "plan", "SKILL.md"), join(cwd, ".ralph/skills/plan/SKILL.md"));
  writeFileSync(join(cwd, ".ralph/plans/SPECIFICATION.md"), "# Orbit Ledger specification\n\nNever use the network. Input is input.csv with exact headers id,name. A valid id is a positive integer and name is non-empty. Output is a JSON array of header-keyed objects on standard output. Deliver exactly two vertical slices. Slice 1 reads input.csv and outputs that JSON locally, with tests. Slice 2 exits with code 2 for any invalid row, with tests and documentation. These decisions are final.\n");
  if (["existing", "update", "cancel", "reset-existing"].includes(caseName)) writeFileSync(join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), "# Existing execution plan\n\nOne deployment slice.\n");
  if (variant === "beads") { mkdirSync(join(cwd, ".beads")); writeFileSync(join(cwd, ".beads/sentinel"), "unchanged\n"); }
  const toolExtension = join(cwd, "acceptance-tool.mjs");
  writeFileSync(toolExtension, `import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function parents(ctx) { for (const value of [join(ctx.cwd, ".ralph"), join(ctx.cwd, ".ralph/plans")]) { const stat = lstatSync(value); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe plan parent"); } const spec = lstatSync(join(ctx.cwd, ".ralph/plans/SPECIFICATION.md")); if (spec.isSymbolicLink() || !spec.isFile()) throw new Error("active specification unavailable"); }
function result() { return { content: [{ type: "text", text: "Wrote .ralph/plans/EXECUTION_PLAN.md" }], details: { written: true } }; }
const parameters = { type: "object", properties: { content: { type: "string", minLength: 1, maxLength: 65536 } }, required: ["content"], additionalProperties: false };
export default function (pi) {
pi.registerTool({ name: "read_planning_inputs", label: "Read planning inputs", description: "Read the exact active specification and, when present, execution plan.", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute(_id, _args, _signal, _update, ctx) { parents(ctx); const spec = readFileSync(join(ctx.cwd, ".ralph/plans/SPECIFICATION.md"), "utf8"), planPath = join(ctx.cwd, ".ralph/plans/EXECUTION_PLAN.md"); const plan = existsSync(planPath) ? readFileSync(planPath, "utf8") : null; return { content: [{ type: "text", text: JSON.stringify({ specification: spec, executionPlan: plan }) }], details: { read: true } }; } });
pi.registerTool({ name: "write_execution_plan", label: "Write execution plan", description: "Exclusively create the exact active execution plan when absent.", parameters, async execute(_id, { content }, _signal, _update, ctx) { parents(ctx); const path = join(ctx.cwd, ".ralph/plans/EXECUTION_PLAN.md"), fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, content, "utf8"); } finally { closeSync(fd); } return result(); } });
pi.registerTool({ name: "update_execution_plan", label: "Update approved execution plan", description: "Atomically replace the active execution plan after explicit in-place agreement.", parameters, async execute(_id, { content }, _signal, _update, ctx) { parents(ctx); const path = join(ctx.cwd, ".ralph/plans/EXECUTION_PLAN.md"), stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe execution plan"); const temporary = join(ctx.cwd, ".ralph/plans/.EXECUTION_PLAN.acceptance-tmp"), fd = openSync(temporary, "wx", 0o600); try { writeFileSync(fd, content, "utf8"); closeSync(fd); renameSync(temporary, path); } catch (error) { try { closeSync(fd); } catch {} rmSync(temporary, { force: true }); throw error; } return result(); } });
}
`);
  const skillPath = join(cwd, ".ralph/skills/plan/SKILL.md"), skillText = readFileSync(skillPath, "utf8"), injection = formatPlanningInjection(loadPlanSkill({ cwd }), definition.mode);
  const orderedTurns = [...definition.turns];
  if (orderedTurns.length === 0) orderedTurns.push({ role: "plugin", text: injection });
  else orderedTurns.splice(1, 0, { role: "plugin", text: injection });
  const prompt = `Continue from this ordered provider-visible conversation. The plugin turn is authoritative and its skill remains in force.\n\n${orderedTurns.map((turn) => `<${turn.role}>\n${turn.text}\n</${turn.role}>`).join("\n")}`;
  const baseline = manifest(cwd), startedAt = new Date(), started = Date.now();
  const run = spawnSync(process.env.PRIME_AGENT_BIN ?? "prime-agent", ["--mode", "json", "--provider", provider, "--model", model, "--thinking", "off", "--no-session", "--offline", "--no-builtin-tools", "--tools", "read_planning_inputs,write_execution_plan,update_execution_plan", "--no-extensions", "-e", toolExtension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--cwd", cwd, "--system-prompt", "You are running controlled prime-ralph planning prompt acceptance. Follow the supplied invocation and canonical skill. When the skill requires studying the active specification or plan, use read_planning_inputs. Use only the narrow offered tools for planning input reads and an explicitly authorized plan action. Do not implement or execute the project.", "--", prompt], { encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env: process.env });
  if (run.error) throw run.error;
  const records = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)), messages = assistantMessages(records), calls = toolCalls(messages), finalMessage = messages.at(-1), finalText = textOf(finalMessage);
  const mutationCalls = calls.filter((call) => call.name === "write_execution_plan" || call.name === "update_execution_plan");
  const planPath = join(cwd, ".ralph/plans/EXECUTION_PLAN.md"), planExists = existsSync(planPath), planContent = planExists ? readFileSync(planPath, "utf8") : "", after = manifest(cwd), changed = changedPaths(baseline, after), assertions = [];
  const check = (name, pass) => assertions.push({ name, pass: Boolean(pass) });
  check("process succeeded", run.status === 0 && !run.signal); check("Prime Agent 0.9.1 recorded", primeAgentVersion === "0.9.1"); check("terminal assistant response", finalMessage && !["error", "aborted", "length"].includes(finalMessage.stopReason));
  check("selected provider observed", messages.every((message) => message.provider === provider)); check("selected model observed", messages.every((message) => message.model === model || message.responseModel === model));
  check("active specification unchanged", after[".ralph/plans/SPECIFICATION.md"]?.sha256 === baseline[".ralph/plans/SPECIFICATION.md"]?.sha256);
  const planUnchanged = after[".ralph/plans/EXECUTION_PLAN.md"]?.sha256 === baseline[".ralph/plans/EXECUTION_PLAN.md"]?.sha256;
  if (["new", "reset-new"].includes(caseName)) {
    check("active specification read after clean injection", calls.some((call) => call.name === "read_planning_inputs")); check("one plan creation call", mutationCalls.length === 1 && mutationCalls[0].name === "write_execution_plan"); check("exact execution plan created", planExists && planContent.trim().length > 0);
    check("vertical slice decisions captured", [/slice/i, /input\.csv/i, /JSON/i, /(?:exit|code).*2|2.*(?:exit|code)/i, /test/i, /document/i].every((pattern) => pattern.test(planContent)));
    check("only execution plan changed", JSON.stringify(changed) === JSON.stringify([".ralph/plans/EXECUTION_PLAN.md"]));
  } else if (caseName === "update") {
    check("one approved update call", mutationCalls.length === 1 && mutationCalls[0].name === "update_execution_plan"); check("execution plan updated", !planUnchanged && /slice 1/i.test(planContent) && /slice 2/i.test(planContent) && /input\.csv/i.test(planContent) && /(?:exit|code).*2|2.*(?:exit|code)/i.test(planContent));
    check("only execution plan changed", JSON.stringify(changed) === JSON.stringify([".ralph/plans/EXECUTION_PLAN.md"]));
  } else if (caseName === "cancel") {
    check("cancel performs no tool call", mutationCalls.length === 0); check("execution plan unchanged", planUnchanged); check("cancel changes no files", changed.length === 0);
  } else {
    check("no mutation before agreement", mutationCalls.length === 0); check("execution plan unchanged", planUnchanged); check("no fixture files changed", changed.length === 0);
    check("warns active plan exists", /active (?:execution )?plan.*(?:exists|already)|already.*active (?:execution )?plan/i.test(finalText)); check("offers discussion", /discuss/i.test(finalText)); check("offers explicit update", /update|edit/i.test(finalText)); check("offers cancellation", /cancel|unchanged|no changes/i.test(finalText));
  }
  if (variant === "beads") check("Beads state unchanged", after[".beads/sentinel"]?.sha256 === baseline[".beads/sentinel"]?.sha256);
  check("no execution started", !/(?:started|beginning|launching) (?:automatic )?execution/i.test(finalText));
  assertSafe(finalText, `${variant}/${caseName} response`); assertSafe(planContent, `${variant}/${caseName} execution plan`);
  results.push({ schemaVersion: 1, evidenceKind: "real-model-behavioral", variant, case: caseName, invocation: { specificationState: "existing", planState: definition.mode.endsWith("existing") ? "existing" : "absent", invocationMode: definition.mode }, fixtureConversation: definition.turns, prompt: { repositoryPath: `templates/${variant}/plan/SKILL.md`, sha256: sha256(skillText) }, runtime: { primeAgentVersion, primeRalphVersion: packageJson.version, nodeVersion: process.version, requestedProvider: provider, requestedModel: model }, observed: { provider: finalMessage?.provider, model: finalMessage?.model, responseModel: finalMessage?.responseModel, stopReason: finalMessage?.stopReason, usage: finalMessage?.usage, toolCalls: calls.map((call) => call.name), finalAssistantText: finalText }, files: { changed, afterManifest: after, executionPlan: planExists ? { bytes: Buffer.byteLength(planContent), sha256: sha256(planContent), content: planContent } : null }, timing: { startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - started }, assertions, verdict: assertions.every((item) => item.pass) ? "pass" : "fail" });
}
const artifact = { schemaVersion: 1, evidenceKind: "real-model-behavioral", generatedAt: new Date().toISOString(), provider, model, results }, serialized = JSON.stringify(artifact, null, 2) + "\n";
assertSafe(serialized, "artifact"); const artifactPath = join(artifactDir, "plan-model-acceptance.json"); writeFileSync(artifactPath, serialized);
const failed = results.filter((result) => result.verdict !== "pass"); console.log(JSON.stringify({ artifactPath, cases: results.length, passed: results.length - failed.length, failed: failed.map((result) => ({ variant: result.variant, case: result.case, assertions: result.assertions.filter((item) => !item.pass).map((item) => item.name) })) }, null, 2));
if (failed.length) process.exit(1);
