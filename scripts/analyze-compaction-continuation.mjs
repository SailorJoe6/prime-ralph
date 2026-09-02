import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.PRIME_AGENT_SOURCE_ROOT;
const loopRoot = process.env.PRIME_AGENT_CORE_ROOT;
if (!root || !loopRoot) {
  console.error("set PRIME_AGENT_SOURCE_ROOT and PRIME_AGENT_CORE_ROOT");
  process.exit(2);
}
const session = await readFile(join(root, "dist/core/agent-session.js"), "utf8");
const loop = await readFile(join(loopRoot, "dist/agent-loop.js"), "utf8");
const checks = {
  turnEndBeforeStop: loop.indexOf('await emit({ type: "turn_end"') < loop.indexOf("shouldStopAfterTurn"),
  stopBeforeContinuation: loop.indexOf("shouldStopAfterTurn") < loop.indexOf("getContinuationMessages"),
  requestedCompactionStops: session.includes(`if (this._pendingRequestedCompaction !== undefined) {\n            return await this._runAutoCompaction("requested", false);`),
  thresholdQueuesGoal: session.includes("if (this._queueGoalContinuationForThresholdCompaction(context.message))"),
  postCompactionUsesThresholdFlag: session.includes(`shouldContinueAfterCompaction = (reason === "threshold" || reason === "requested") && this._continueAfterThresholdCompaction`),
};
for (const [name, passed] of Object.entries(checks)) console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
if (!Object.values(checks).every(Boolean)) process.exit(1);
console.log("Conclusion: requested compaction stops before normal continuation generation and does not itself queue the goal continuation.");
