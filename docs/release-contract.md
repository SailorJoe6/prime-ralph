# Release contract

This document defines the standalone package boundary and the checks required before publishing a release.

## Package contract

- Node.js 20 or newer.
- Peer dependency: Prime Agent `0.9.1`.
- ESM package with the exports listed in `package.json`.
- Package contents are limited to `bin/`, `src/`, `templates/`, `scripts/`, `docs/`, `README.md`, and `LICENSE`.
- The default extension registers production `/reset`, `/spec-it-out`, `/plan`, and `/execute` behavior plus the internal `ralph_lifecycle` control, and does not register or shadow `/clear`.

The default extension does not start an agent, select a provider, execute shell commands, invoke Beads, choose a repository, or supply task criteria. The separate initializer performs only its explicit filesystem setup and, only with `--beads` and missing Beads state, invokes `bd init --skip-agents --skip-hooks`.

## Slice 2 initialization contract

`prime-ralph init [--project <path>] [--beads] [--stealth]`:

1. requires an existing selected project directory;
2. creates only missing `.ralph` structure, bundled canonical internal prompts, and the project-local extension directory symlink;
3. creates no direct Ralph skills under `.agents/skills`, removes only exact recognized legacy canonical-skill symlinks on repeated initialization, and preserves every conflicting, renamed, dangling, or unrelated entry;
4. selects Beads templates only through `--beads` and preflights `bd` before Ralph mutations when initialization is required;
5. adds only leaf artifacts created by that invocation to Git's local exclude when `--stealth` is selected; and
6. never imports the production extension, launches Prime Agent, calls a provider, delivers a skill, selects a phase, or starts a lifecycle.

Package updates do not invoke initialization or refresh initialized project content. All five default and Beads-aware templates are shipped so future workflow slices do not depend on silently replacing project-customizable skills.

## Slice 3 specification contract

The default extension:

1. sends one session-ID-keyed prepare turn on a real no-spec session start and never during reload;
2. classifies the exact active specification path without following symlink parents or destinations;
3. sends `/spec-it-out` as one follow-up in the current conversation with closed, versioned state metadata;
4. performs no command-handler planning-document mutation;
5. expands `/reset` to deliver ordered reset-existing guidance when an active spec appears; and
6. starts no planning automatically when a specification appears during the current specification phase.

A Slice 3 `spec-it-out` skill declares `prime-ralph-invocation-version: 1`. Older project-local skills are preserved but rejected with an actionable compatibility error instead of being interpreted as current prompts.


## Slice 4 planning contract

With an active exact specification, startup and explicit fresh planning deliver one ordered `prepare`-then-`plan` turn. The extension supplies a closed versioned plan-state mode, preserves existing plans, and never writes a planning document. Existing-plan `/plan` keeps current context only after planning is established. Planning `/reset` uses the shared clean boundary for both active-plan states. Missing specifications and incompatible or conflicting paths fail before transition.

Slice 4 ended with the `/reset`, `/spec-it-out`, and `/plan` catalog. Slice 5 adds `/execute` and complete blocked handling while direct Ralph `skill:*` alternatives remain absent.

## Slice 5 execution contract

A valid `/execute` starts one automatic execution run. Prime Agent's native thread goal is the only mechanism that starts later agent turns; the extension adds no competing loop. The versioned `ralph_lifecycle` tool requires the current run and cycle identifiers and explicit execute-skill decisions for continue, wait, ready, block, and complete. Native goal pause, resume, and clear map to the same run. Exact pair transactions protect normal blocked recovery and optional named archive. If the exact blocked files were moved back manually, the extension verifies them against the saved hashes, keeps execution stopped while the original blocker is checked, and removes only the saved marker after explicit confirmation. Completed cycles append only to `.ralph/logs/EXECUTION_LOG.md`; waiting checks do not. See [`execution.md`](execution.md).

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
PRIME_AGENT_ROOT=/path/to/prime-agent npm run accept:init
PRIME_AGENT_ROOT=/path/to/prime-agent npm run accept:package-install
PRIME_AGENT_ROOT=/path/to/prime-agent npm run compat
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:reset
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:specification
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:planning
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:execution
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:blocked-recovery
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:reset-busy
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:reset-lifecycle
PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 \
PRIME_RALPH_ACCEPT_PROVIDER=<provider> \
PRIME_RALPH_ACCEPT_MODEL=<model> \
npm run accept:model:spec-it-out -- --variant all --case all
PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 \
PRIME_RALPH_ACCEPT_PROVIDER=<provider> \
PRIME_RALPH_ACCEPT_MODEL=<model> \
npm run accept:model:plan -- --variant all --case all
PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 \
PRIME_RALPH_ACCEPT_PROVIDER=<provider> \
PRIME_RALPH_ACCEPT_MODEL=<model> \
npm run accept:model:execute
PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 \
PRIME_RALPH_ACCEPT_PROVIDER=<provider> \
PRIME_RALPH_ACCEPT_MODEL=<model> \
npm run accept:model:blocked-recovery -- --variant all
npm run package:check
npm pack --dry-run
```

The reset, specification, and planning lifecycle acceptance scripts are disposable and use deterministic providers. `accept:reset` also starts and closes a real Prime Agent IPython kernel. The opt-in model matrix is nondeterministic behavioral evidence and writes only a curated, secret-scanned artifact.

Then extract the produced tarball in a clean temporary directory, import `src/index.js`, and verify `/reset` registration with a Prime Agent-shaped extension API fixture.

## Evidence boundaries

- Unit tests and static prompt checks do not prove host lifecycle ordering or model behavior.
- The specification lifecycle acceptance proves startup ordering, reload suppression, context retention, reset projection, and an unambiguous native extension-command catalog on Prime Agent `0.9.1`.
- The planning lifecycle acceptance proves phase selection, ordered skill delivery, clean and current-context `/plan` paths, both planning reset branches, document protection, and no execution start.
- The opt-in model matrices prove only the recorded provider/model outcomes under its restricted fixture tools; it covers new creation, the initial existing-spec menu, confirmed future creation, agreed active update, cancellation, and reset-existing behavior, and is not deterministic CI evidence.
- The disk-backed execution acceptance proves provider context, JSONL, session identity, and REPL continuity on Prime Agent `0.9.1`.
- The disk-backed blocked-recovery acceptance proves a real manually restored pair is verified and accepted without another move, the blocked context and current tool results remain visible through confirmation, execution does not restart automatically, and a later `/execute` creates a fresh run.
- The busy acceptance proves ordering behind an active parent turn and existing follow-up.
- The lifecycle acceptance proves durable custom-compaction resume, cancellation without partial prepare, provider-failure state, and safe retry.
- The public extension API does not expose Prime Agent's strong descendant-RLM quiescence barrier. Slice 1 therefore does not claim that an idle parent with a running tracked RLM child is gated.
- Historical native JSON, RPC, ACP, text, and daemon smokes do not yet prove `/reset` parity in every mode.
- Stable prompt-prefix bytes are not evidence of provider cache billing.

A release must report the descendant-RLM gap rather than treating it as passed evidence.
