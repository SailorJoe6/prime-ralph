import { discoverSkillConfig, phaseIdentity, selectPhase } from "./skill-config.js";

export function selectConfiguredPhase({ state, discovery }) {
  const phase = selectPhase(state);
  const skill = discovery?.skills?.[phase] ?? null;
  return { ...phaseIdentity(phase, skill), skill, diagnostics: discovery?.diagnostics ?? [] };
}

export function persistPhaseMarker(appendMarker, selection, cycleId) {
  if (typeof appendMarker !== "function") throw new TypeError("appendMarker is required");
  const marker = { kind: "phase_selection", cycleId, phase: selection.phase, skillIdentity: selection.skillIdentity };
  appendMarker(marker);
  return marker;
}

export function discoverAndSelectPhase(options = {}) {
  const discovery = discoverSkillConfig(options);
  return { discovery, selection: selectConfiguredPhase({ state: options.state ?? {}, discovery }) };
}
