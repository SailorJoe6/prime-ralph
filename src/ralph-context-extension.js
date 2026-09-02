import { projectRalphBootstrapContext } from "./ralph-context.js";

/** Opt-in context hook. It activates only after a recognized Ralph compaction. */
export default function ralphContextExtension(pi) {
  let active = false;
  pi.on("session_compact", (event) => {
    active = event?.fromExtension === true && typeof event.compactionEntry?.summary === "string" && event.compactionEntry.summary.startsWith("RALPH_BOOTSTRAP:");
  });
  pi.on("context", (event) => {
    if (!active) return;
    return { messages: projectRalphBootstrapContext(event.messages) };
  });
}
