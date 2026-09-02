import test from "node:test";
import assert from "node:assert/strict";
import { projectRalphBootstrapContext } from "../src/ralph-context.js";

test("projects only the latest Ralph summary and goal continuation", () => {
  const messages = [
    { role: "user", content: "old" },
    { role: "assistant", content: "old" },
    { role: "compactionSummary", summary: "RALPH" },
    { role: "assistant", content: "retained stale attempt" },
    { role: "custom", customType: "goal_context", content: "continue" },
  ];
  assert.deepEqual(projectRalphBootstrapContext(messages), [messages[2], messages[4]]);
});

test("does not project an un-compacted context", () => {
  const messages = [{ role: "user", content: "task" }, { role: "assistant", content: "answer" }];
  assert.deepEqual(projectRalphBootstrapContext(messages), messages);
});
