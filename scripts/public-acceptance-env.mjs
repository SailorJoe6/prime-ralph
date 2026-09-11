const PRIVATE_EXACT_KEYS = new Set([
  "PRIME_AGENT_BIN",
  "PRIME_AGENT_KERNEL_OWNER_PID",
  "RLM_DEPTH",
  "RLM_SESSION_DIR",
  "RLM_HARNESS_STATE_DIR",
  "RLM_GLOBAL_HARNESS_STATE_DIR",
  "RLM_MAX_DEPTH",
]);

export function sanitizedPrimeAgentEnvironment(source = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("PRIME_AGENT_INTERNAL_") || PRIVATE_EXACT_KEYS.has(key) || value === undefined) continue;
    clean[key] = value;
  }
  return clean;
}
