import { createRalphExtension } from "../src/ralph-extension.js";
const modes = ["interactive", "daemon", "rpc", "headless"];
const result = modes.map((mode) => { const handlers = new Map(); const pi = { on: (name, handler) => handlers.set(name, handler), sendMessage: () => Promise.resolve() }; createRalphExtension({ enabled: true })(pi); return { mode, hooks: [...handlers.keys()], lifecycleFactoryLoaded: handlers.has("turn_end") && handlers.has("session_compact") }; });
if (result.some((item) => !item.lifecycleFactoryLoaded)) process.exit(1);
console.log(JSON.stringify({ modes: result, note: "hook-registration smoke only; host transport behavior requires native mode harnesses" }, null, 2));
