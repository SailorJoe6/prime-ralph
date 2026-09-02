import { spawnSync } from "node:child_process";
import { join } from "node:path";
const cli = process.env.PRIME_AGENT_BIN ?? "prime-agent";
const result = spawnSync(cli, ["--mode", "rpc", "--offline", "--no-extensions", "-e", join(process.cwd(), "src/index.js"), "--cwd", process.cwd()], { input: JSON.stringify({ id: "rpc-smoke", type: "abort" }) + "\n", encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024 });
if (result.error) throw result.error;
const records = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const response = records.find((r) => r.type === "response" && r.command === "abort");
if (result.status !== 0 || !response?.success) throw new Error(`RPC smoke failed: status=${result.status}`);
console.log(JSON.stringify({ status: result.status, abortAccepted: true, records: records.length }));
