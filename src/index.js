/** Behavior-neutral Prime Agent extension entry point. */
export default function primeRalph(_pi) {
  // Deliberately no-op until host lifecycle integration is complete.
}
export { RalphCycleCoordinator } from "./cycle-coordinator.js";
export { createContinuationAdapter } from "./continuation-adapter.js";
export { discoverSkillConfig, loadSkillConfiguration, phaseIdentity, selectPhase } from "./skill-config.js";
export { BeadsCoordinator, runQualityGates } from "./beads-coordination.js";
export { GoalLifecycle } from "./goal-lifecycle.js";
export { diagnosticSnapshot, isCompatiblePrimeAgent } from "./diagnostics.js";
