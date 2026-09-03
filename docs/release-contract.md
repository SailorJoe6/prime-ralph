# Release contract

This document defines the standalone package boundary and the checks required before publishing a release.

## Package contract

- Node.js 20 or newer.
- Peer dependency: Prime Agent `0.9.1`.
- ESM package with the exports listed in `package.json`.
- Package contents are limited to `src/`, `scripts/`, `docs/`, `README.md`, and `LICENSE`.
- The default extension registers production `/reset` behavior and does not register or shadow `/clear`.

The package does not start an agent, select a provider, execute shell commands, invoke Beads, choose a repository, or supply task criteria.

## Slice 1 reset contract

The default extension:

1. registers `/reset` through `pi.registerCommand`;
2. validates the exact canonical project prepare skill before mutation;
3. appends a bounded opaque marker and starts a matching public custom compaction;
4. uses the marker's real entry ID and no summarization provider call;
5. removes the fixed Ralph empty-summary wrapper and admits one hidden prepare follow-up;
6. enforces the newest prepare boundary exactly, including for the short-session projection fallback; and
7. records completion only for the matching reset turn.

The extension preserves the current host system prompt and does not invoke session replacement, tree, goal, autonomous, phase, or REPL lifecycle operations. Persistent state contains only protocol status, bounded mode metadata, and opaque request or entry IDs, not transcript or skill content.

Historical lifecycle and coordination modules remain importable POC seams. Their old automatic compaction, continuation, phase, goal, and Beads assumptions are not enabled by the default extension and are not part of the Slice 1 production contract.

## Validation contract

Run:

```sh
npm test
PRIME_AGENT_ROOT=/path/to/prime-agent npm run compat
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:reset
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:reset-busy
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:reset-lifecycle
npm run package:check
npm pack --dry-run
```

The acceptance scripts are disposable and use deterministic providers. `accept:reset` also starts and closes a real Prime Agent IPython kernel.

Then extract the produced tarball in a clean temporary directory, import `src/index.js`, and verify `/reset` registration with a Prime Agent-shaped extension API fixture.

## Evidence boundaries

- Unit tests do not prove host lifecycle ordering.
- The disk-backed acceptance proves provider context, JSONL, session identity, and REPL continuity on Prime Agent `0.9.1`.
- The busy acceptance proves ordering behind an active parent turn and existing follow-up.
- The lifecycle acceptance proves durable custom-compaction resume, cancellation without partial prepare, provider-failure state, and safe retry.
- The public extension API does not expose Prime Agent's strong descendant-RLM quiescence barrier. Slice 1 therefore does not claim that an idle parent with a running tracked RLM child is gated.
- Historical native JSON, RPC, ACP, text, and daemon smokes do not yet prove `/reset` parity in every mode.
- Stable prompt-prefix bytes are not evidence of provider cache billing.

A release must report the descendant-RLM gap rather than treating it as passed evidence.
