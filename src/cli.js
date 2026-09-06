import { resolve } from "node:path";
import { initializeProject } from "./init.js";

export class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; }
}

export const USAGE = `Usage: prime-ralph <command> [options]

Commands:
  init [--project <path>] [--beads] [--stealth]
      Initialize project-local Prime Agent Ralph support without overwriting existing content.
  recover [--project <path>]
      Print provider-free offline inspection steps without starting or changing anything.

Options:
  --project <path>  Select the project root (default: current directory)
  --beads           Install Beads-aware templates and initialize missing Beads state (init only)
  --stealth         Exclude only artifacts created by this run through Git's local exclude (init only)
  -h, --help        Show this help
`;

export function parseCli(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { help: true };
  if (!["init", "recover"].includes(argv[0])) throw new UsageError(`Unknown command: ${argv[0]}`);
  const command = argv[0], options = {};
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--beads" || arg === "--stealth") {
      if (command !== "init") throw new UsageError(`${arg} is available only for init`);
      const key = arg.slice(2);
      if (seen.has(key)) throw new UsageError(`Duplicate option: ${arg}`);
      seen.add(key); options[key] = true; continue;
    }
    if (arg === "--project" || arg.startsWith("--project=")) {
      if (seen.has("project")) throw new UsageError("Duplicate option: --project");
      const value = arg === "--project" ? argv[++index] : arg.slice("--project=".length);
      if (!value || value.startsWith("--")) throw new UsageError("--project requires a path");
      seen.add("project"); options.project = value; continue;
    }
    throw new UsageError(`Unknown option: ${arg}`);
  }
  return { command, options };
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\"'\"'")}'`; }

export function offlineRecoveryGuidance(project = process.cwd()) {
  const root = resolve(project);
  return `Provider-free offline inspection (this command starts and changes nothing):
1. Stop the affected Prime Agent process.
2. Start a fresh native session in a separate shell:
   prime-agent --no-extensions --cwd ${shellQuote(root)}
3. Do not add --continue, --resume, or --fork.
4. Inspect the durable worktree, planning documents, Git state, and issue state before deciding whether to start new work.
`;
}

export function runCli(argv, io = {}, runtime = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const parsed = parseCli(argv);
    if (parsed.help) { stdout.write(USAGE); return 0; }
    if (parsed.command === "recover") { stdout.write(offlineRecoveryGuidance(parsed.options.project)); return 0; }
    const initialize = runtime.initializeProject ?? initializeProject;
    const result = initialize(parsed.options, runtime);
    for (const path of result.created) stdout.write(`created: ${path}\n`);
    for (const path of result.removed) stdout.write(`removed legacy link: ${path}\n`);
    for (const warning of result.warnings) stderr.write(`warning: ${warning}\n`);
    stdout.write(`prime-ralph initialized: ${result.project}\n`);
    return 0;
  } catch (error) {
    stderr.write(`prime-ralph: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
