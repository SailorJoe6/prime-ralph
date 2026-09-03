import { readFileSync } from "node:fs";
const packageData = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export function diagnosticSnapshot({ primeAgentVersion = null, state = null } = {}) { return { plugin: "prime-ralph", version: packageData.version, primeAgentVersion: primeAgentVersion ? String(primeAgentVersion) : null, state: state && typeof state === "object" ? { state: state.state ?? null, cycleId: state.cycleId ?? null } : null }; }
export function isCompatiblePrimeAgent(version) { return /^0\.9\.1(?:$|[-+])/.test(String(version ?? "")); }
