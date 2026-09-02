import { readFileSync } from "node:fs";
const packageData = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export function diagnosticSnapshot({ primeAgentVersion = null, state = null } = {}) { return { plugin: "prime-ralph", version: packageData.version, primeAgentVersion: primeAgentVersion ? String(primeAgentVersion) : null, state: state && typeof state === "object" ? { state: state.state ?? null, cycleId: state.cycleId ?? null } : null }; }
export function isCompatiblePrimeAgent(version) { const match = String(version ?? "").match(/^(\d+)\.(\d+)\./); if (!match) return false; const major = Number(match[1]); const minor = Number(match[2]); return major === 0 && minor >= 8 && minor < 9; }
