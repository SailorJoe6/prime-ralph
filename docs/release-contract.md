# Release contract

This document defines the standalone package boundary and the checks required before publishing a release.

## Package contract

- Node.js 20 or newer.
- Peer dependency: Prime Agent `>=0.8.0 <0.9.0`.
- ESM package with the exports listed in `package.json`.
- Package contents are limited to `src/`, `scripts/`, `docs/`, `README.md`, and `LICENSE`.
- The default extension export is behavior-neutral and remains a no-op.

The package does not start an agent, select a provider, execute shell commands, invoke Beads, or choose a repository. Consumers must inject those capabilities through explicit adapters.

## Lifecycle contract

The opt-in factory, `createRalphExtension({ enabled: true })`:

1. validates its options and the supplied Prime Agent version;
2. requests compaction only at an eligible final normal assistant turn;
3. emits a deterministic `RALPH_BOOTSTRAP:` summary using a valid host boundary;
4. waits for compaction to settle; and
5. schedules at most one continuation for the matching cycle and boundary.

Stale, duplicate, cancelled, or mismatched continuations fail closed. Custom bootstrap instructions are capped at 4,000 characters. Hosts that let this extension own continuation must disable automatic Prime Agent goals unless they provide an explicit ownership handoff.

## Coordination contract

`startManagedCycle()` is the narrow orchestration entry point. It claims work through an injected `bd` adapter, evaluates configured phase gates, and writes a bounded checkpoint only when durable evidence exists. It does not bypass the adapter transaction boundary or implicitly mark work complete.

The package includes adapters and pure seams for:

- cycle state and recovery;
- continuation admission;
- phase skill discovery and selection;
- Beads ownership and quality gates;
- goal lifecycle state; and
- sanitized diagnostics and observability.

These are libraries, not a complete runner. The host owns configuration, process lifetime, repository policy, and user-facing reporting.

## Validation contract

Run the following before a release:

```sh
npm test
npm run compat
npm run package:check
npm pack --dry-run
```

Then perform a clean-install smoke test: extract the tarball, import `src/index.js`, and verify the default entry point. `package:check` checks mode labels and package shape; it does not prove full behavior for every native mode.

For source and session POCs, set `PRIME_AGENT_SOURCE_ROOT` and `PRIME_AGENT_CORE_ROOT` to the installation under test. For native transport evidence, follow [`native-transport-acceptance.md`](native-transport-acceptance.md).

## Evidence boundaries

- Unit tests do not prove host lifecycle ordering.
- Fixture POCs do not prove provider or transport behavior.
- Compatibility checks prove the analyzed source/API contract only.
- Native JSON, RPC, and ACP smoke checks prove bounded protocol behavior only.
- Text-mode evidence requires a pseudo-terminal.
- Daemon checks require a disposable process, a unique socket, and protocol shutdown.
- Stable prompt-prefix bytes are not evidence of provider cache billing.

A release must describe unresolved assumptions instead of promoting bounded evidence into a broader claim.
