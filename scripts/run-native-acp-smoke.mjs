import { spawnSync } from "node:child_process";
import { join } from "node:path";
const cli = process.env.PRIME_AGENT_BIN ?? "prime-agent";
const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "prime-ralph-poc", version: "0.1.0" }, capabilities: {} } },
  { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } },
];
const result = spawnSync(cli, ["--mode", "acp", "--offline", "--no-extensions", "-e", join(process.cwd(), "src/index.js"), "--cwd", process.cwd()], { input: requests.map(JSON.stringify).join("\n") + "\n", encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024 });
if (result.error) throw result.error;
const records = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const init = records.find((r) => r.id === 1); const session = records.find((r) => r.id === 2);
if (result.status !== 0 || init?.result?.agentInfo?.version !== "0.8.0" || !session?.result?.sessionId) throw new Error(`ACP smoke failed: status=${result.status}`);
console.log(JSON.stringify({ status: result.status, protocolVersion: init.result.protocolVersion, sessionCreated: true, records: records.length }));
