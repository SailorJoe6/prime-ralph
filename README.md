# prime-ralph

A standalone, opt-in Prime Agent plugin design for Ralph-style low-context-rotation cycles in one long-lived session.

## Status

Research and implementation slices are complete through package validation. The repository contains tested seams for lifecycle observation, controlled compaction, explicit continuation, cycle recovery, configurable repository skills, Beads ownership, quality gates, lease heartbeats, and cache-boundary analysis. The default extension entry point remains behavior-neutral until final host integration is completed.

## Development

```sh
npm test
npm run compat
npm run poc:compaction-order
```

The POC commands require environment paths documented in their help-free script headers: `PRIME_AGENT_SOURCE_ROOT` and, for core-loop fixtures, `PRIME_AGENT_CORE_ROOT`.

## Compatibility and safety

The supported Prime Agent range is `>=0.8.0 <0.9.0`. Automatic Prime Agent goals must be disabled for Ralph-managed sessions unless a host-supported ownership handoff exists. Requested compaction does not automatically preserve goal continuation; the coordinator must admit one explicit continuation after compaction settles. Provider cache billing is not inferred from stable prompt prefixes.

See `docs/research-slice-2.md` for reproducible findings and known limitations.
