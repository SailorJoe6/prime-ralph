import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const entry = await import(pathToFileURL(new URL("../src/index.js", import.meta.url).pathname).href);
if (typeof entry.default !== "function") throw new Error("default extension entry is not callable");
for (const mode of ["interactive", "daemon", "rpc", "headless"]) { entry.default({ mode }); }
console.log("mode smoke OK: interactive, daemon, rpc, headless");
if (!/^>=0\.8\.0 <0\.9\.0$/.test(packageJson.peerDependencies?.["prime-agent"] ?? "")) throw new Error("unsupported peer range");
console.log(`package check OK: ${packageJson.name}@${packageJson.version}`);
