import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
let packageJson;
try {
  const packagePath = process.env.PRIME_AGENT_ROOT
    ? join(process.env.PRIME_AGENT_ROOT, "package.json")
    : require.resolve("prime-agent/package.json");
  packageJson = JSON.parse(await readFile(packagePath, "utf8"));
} catch {
  console.error("prime-agent is not installed; set PRIME_AGENT_ROOT to its package root for a local check");
  process.exit(2);
}

if (packageJson.version !== "0.9.3") {
  console.error(`unsupported Prime Agent version: ${packageJson.version}`);
  process.exit(1);
}

console.log(`Prime Agent compatibility accepted: ${packageJson.version}`);
