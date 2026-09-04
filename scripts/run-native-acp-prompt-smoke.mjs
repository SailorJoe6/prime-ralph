import { spawn } from "node:child_process";
import { join } from "node:path";

const cliArgs = ["--mode", "acp", "--offline", "--no-extensions", "-e", join(process.cwd(), "src/index.js"), "--cwd", process.cwd()];
const provider = process.env.PRIME_RALPH_ACCEPT_PROVIDER;
const model = process.env.PRIME_RALPH_ACCEPT_MODEL;
if ((provider && !model) || (!provider && model)) throw new Error("set both PRIME_RALPH_ACCEPT_PROVIDER and PRIME_RALPH_ACCEPT_MODEL");
if (provider) cliArgs.push("--provider", provider, "--model", model);
const child = spawn(process.env.PRIME_AGENT_BIN ?? "prime-agent", cliArgs, { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "", stderr = "";
const records = [], waiters = [];
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const record = JSON.parse(line); records.push(record);
    for (let cursor = waiters.length - 1; cursor >= 0; cursor -= 1) if (waiters[cursor].predicate(record)) {
      const waiter = waiters.splice(cursor, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(record);
    }
  }
});
const waitFor = (predicate, label) => new Promise((resolve, reject) => {
  const found = records.find(predicate); if (found) return resolve(found);
  const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error(`ACP ${label} timeout; records=${records.length}; methods=${records.map((record) => record.method ?? record.id ?? record.type).slice(-20).join(",")}; stderrBytes=${Buffer.byteLength(stderr)}`)), 60_000) };
  waiters.push(waiter);
});
const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "prime-ralph-poc", version: "0.1.0" }, capabilities: {} } });
  send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
  const session = await waitFor((record) => record.id === 2, "session/new");
  send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: session.result.sessionId, prompt: [{ type: "text", text: "Reply with the single word ready." }] } });
  const prompt = await waitFor((record) => record.id === 3, "session/prompt");
  if (!prompt.result?.stopReason) throw new Error(`ACP prompt response missing stopReason; stderrBytes=${Buffer.byteLength(stderr)}`);
  console.log(JSON.stringify({ protocolVersion: 1, sessionCreated: true, promptStopReason: prompt.result.stopReason, records: records.length, provider: provider ?? "configured-default", model: model ?? "configured-default" }));
} finally {
  child.kill();
}
