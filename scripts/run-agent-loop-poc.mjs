import { pathToFileURL } from "node:url";

const coreRoot = process.env.PRIME_AGENT_CORE_ROOT;
if (!coreRoot) {
  console.error("set PRIME_AGENT_CORE_ROOT to the pi-agent-core package root");
  process.exit(2);
}
const { Agent } = await import(pathToFileURL(`${coreRoot}/dist/agent.js`).href);

const trace = [];
let calls = 0;
const model = { provider: "poc", id: "fake", api: "poc", contextWindow: 100000 };
const responseFor = (text) => {
  const message = {
    role: "assistant", content: [{ type: "text", text }],
    api: "poc", provider: "poc", model: "fake", stopReason: "stop",
    usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "done", reason: "stop", message }; },
    async result() { return message; },
  };
};
const continuation = { role: "custom", customType: "goal_context", content: "<goal_context>continue</goal_context>", display: true, timestamp: Date.now() };
const agent = new Agent({
  initialState: { systemPrompt: "poc", messages: [], tools: [] },
  convertToLlm: () => [],
  streamFn: () => { calls += 1; return responseFor(calls === 1 ? "normal response" : "continuation response"); },
  getContinuationMessages: async () => { trace.push({ type: "continuation_hook", calls }); return calls === 1 ? [continuation] : []; },
});
agent.subscribe((event) => {
  trace.push({ type: event.type, role: event.message?.role, customType: event.message?.customType, hasToolCall: event.message?.content?.some((x) => x.type === "toolCall") ?? false });
});
await agent.prompt("initial");
console.log(JSON.stringify({ calls, trace }, null, 2));
