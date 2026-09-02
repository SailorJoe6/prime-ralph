import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OBSERVABILITY_HOOKS, createLifecycleTracer } from "./observability.js";

/**
 * Opt-in, behavior-neutral lifecycle instrumentation for the research/POC
 * phase. It records shapes and counts only; transcript content is excluded.
 */
export default function lifecycleObservability(pi) {
  let tracePath;
  let tracer;
  const record = (type, event, ctx) => {
    if (!tracer) return;
    tracer.record(type, event, ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    const dir = join(ctx.cwd, ".prime-ralph");
    mkdirSync(dir, { recursive: true });
    tracePath = join(dir, "lifecycle.jsonl");
    tracer = createLifecycleTracer({
      sink: (entry) => appendFileSync(tracePath, `${JSON.stringify(entry)}\n`, "utf8"),
    });
    record("session_start", _event, ctx);
  });

  for (const hook of OBSERVABILITY_HOOKS) {
    if (hook === "session_start") continue;
    pi.on(hook, (event, ctx) => record(hook, event, ctx));
  }
}
