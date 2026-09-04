import { initializeProject } from "./init.js";

export class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; }
}

export const USAGE = `Usage: prime-ralph init [--project <path>] [--beads] [--stealth]

Initialize project-local Prime Agent Ralph support without overwriting existing content.

Options:
  --project <path>  Select the project root (default: current directory)
  --beads           Install Beads-aware templates and initialize missing Beads state
  --stealth         Exclude only artifacts created by this run through Git's local exclude
  -h, --help        Show this help
`;

export function parseCli(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { help: true };
  if (argv[0] !== "init") throw new UsageError(`Unknown command: ${argv[0]}`);
  const options = {};
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--beads" || arg === "--stealth") {
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
  return { command: "init", options };
}

export function runCli(argv, io = {}, runtime = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const parsed = parseCli(argv);
    if (parsed.help) { stdout.write(USAGE); return 0; }
    const result = initializeProject(parsed.options, runtime);
    for (const path of result.created) stdout.write(`created: ${path}\n`);
    for (const warning of result.warnings) stderr.write(`warning: ${warning}\n`);
    stdout.write(`prime-ralph initialized: ${result.project}\n`);
    return 0;
  } catch (error) {
    stderr.write(`prime-ralph: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
