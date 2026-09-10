# Release contract

This document defines the standalone package boundary and the checks required before publishing a release.

## Package contract

- Node.js 20 or newer.
- Peer dependency: Prime Agent `0.9.3`.
- ESM package with the exports listed in `package.json`.
- Package contents are limited to `bin/`, `src/`, `templates/`, `scripts/`, `docs/`, `README.md`, and `LICENSE`.
- The default extension registers production `/reset`, `/spec-it-out`, `/plan`, `/execute`, and provider-free `/ralph-recover` behavior plus the internal `ralph_lifecycle` control, and does not register or shadow `/clear`.

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

A valid `/execute` starts one automatic execution run. Prime Agent's native thread goal is the only mechanism that starts later agent turns; the extension adds no competing loop. The versioned `ralph_lifecycle` tool requires the current run and cycle identifiers and explicit execute-skill decisions for continue, wait, ready, narrow post-ready `recover-driver`, block, and complete. Native goal pause, resume, and clear map to the same run. Exact pair transactions protect normal blocked recovery and optional named archive. If the exact blocked files were moved back manually, the extension verifies them against the saved hashes, keeps execution stopped while the original blocker is checked, and removes only the saved marker after explicit confirmation. Completed cycles append only to `.ralph/logs/EXECUTION_LOG.md`; waiting checks do not. See [`execution.md`](execution.md).

## Slice 1 reset contract

The default extension:

1. registers `/reset` through `pi.registerCommand`;
2. validates the exact canonical project prepare skill before mutation;
3. appends a bounded opaque marker and starts a matching public custom compaction;
4. uses the marker's real entry ID and no summarization provider call;
5. preserves Prime Agent's natural post-compaction provider context and adds one hidden prepare follow-up;
6. performs no successful provider-message filtering, replacement, or reordering; and
7. records completion only for the matching reset turn.

If Prime Agent refuses compaction because the session is too short or already compacted, no reset occurs, the conversation remains unchanged, and no projection fallback is used. The exact short-session message is `No reset was performed because the session is too short to warrant compaction.`

Ordinary reset preserves the current host system prompt and does not invoke session replacement, tree, goal, autonomous, phase, or REPL lifecycle operations. Persistent state contains only protocol status, bounded mode metadata, and opaque request or entry IDs, not transcript or skill content. Research-only package APIs and POC executables are not shipped.

## Provider-free recovery contract

`/ralph-recover` validates one fully correlated poisoned reset transaction. A provider-visible poison uses same-session `navigateTree(anchorId, { summarize: false })`, rejects edit-semantic anchors, and verifies the exact new leaf and session identity. A failed `execute-round` poison may instead recover in place only when the latest compaction after that poison has an exact `firstKeptEntryId` strictly after its hidden message and the latest durable state binds the same request, session, lifecycle, cycle, and retired driver, retains the stale reset with no pending semantic work, and the matching driver goal is no longer live. The in-place path does not navigate and preserves the current summaries, conversation, and unrelated goal. Both modes append sanitized mode-bound provenance followed by an inactive `recoveryRequired` workflow state. They start no provider, compaction, goal, prompt, lifecycle decision, driver, or automatic execution. Ambiguity fails closed; append uncertainty quarantines the current runtime until reload; completed recovery is idempotent after later ordinary entries. `prime-ralph recover --project <path>` only prints the non-mutating `prime-agent --no-extensions --cwd <project>` fallback and never starts it.

## Validation contract

Run:

```sh
npm test
npm run accept:public-setup-discovery
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
npm run accept:execution-goal-closeout
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:execution-boundary-recovery
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:execution-ready-handoff
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:recovery
npm run accept:execution-pause-resume
npm run accept:execution-admission-failure
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
npm run accept:native-rpc
npm run accept:native-acp
npm run package:check
npm pack --dry-run
```

The reset, specification, and planning lifecycle acceptance scripts are disposable and use deterministic providers. `accept:reset` also starts and closes a real Prime Agent IPython kernel. The opt-in model matrix is nondeterministic behavioral evidence and writes only a curated, secret-scanned artifact.

Then extract the produced tarball in a clean temporary directory, import `src/index.js`, and verify `/reset` registration with a Prime Agent-shaped extension API fixture.

## Evidence boundaries

- Unit tests and static prompt checks do not prove host lifecycle ordering or model behavior.
- The public setup-discovery acceptance proves the initialized source and packed-package extension are discovered by a spawned supported RPC host with skills, prompt templates, themes, context files, and session persistence disabled, expose the exact project command catalog, and acknowledge abort. It does not control the host daemon, assert provider or canonical-skill behavior, or prove command lifecycle behavior.
- The specification lifecycle acceptance proves startup ordering, reload suppression, context retention, native reset boundaries, transcript transparency, and an unambiguous native extension-command catalog on Prime Agent `0.9.3`.
- The planning lifecycle acceptance proves phase selection, ordered skill delivery, clean and current-context `/plan` paths, both planning reset branches, document protection, and no execution start.
- The opt-in model matrices prove only the recorded provider/model outcomes under its restricted fixture tools; it covers new creation, the initial existing-spec menu, confirmed future creation, agreed active update, cancellation, and reset-existing behavior, and is not deterministic CI evidence.
- The native recovery acceptance proves exact provider-free tree navigation and lossless in-place post-compaction repair, append-only JSONL prefix and active/abandoned branch retention, compacted-summary, conversation, unrelated-goal, same-session, live-REPL, and worktree continuity, cancellation safety, reload idempotence, and zero provider/compaction/goal/driver action.
- The disk-backed execution acceptances prove successful reset-flavor compaction precedes each execute provider request, automatic projection is absent, a direct provider retry reclaims only its exact durable pass, Continue and Ready wait for lifecycle closeout, the next cycle receives a fresh signal and one normally settled provider entry, a newer child custom handoff cannot make a historical goal continuation abort a readied replacement driver, pause/resume retains the complete current iteration, and JSONL, session identity, and REPL remain continuous on Prime Agent `0.9.3`. The rejected-boundary variant holds public session input admission, observes Prime Agent's asynchronous `send_message` error, releases the rejected queue, and uses the next public input boundary to prove one failed round, no provider or cycle admission, provider-free goal clear, and restored ordinary operator control.
- The disk-backed blocked-recovery acceptance proves a real manually restored pair is verified and accepted without another move, native compaction precedes the blocked pass and every post-boundary message remains visible unchanged through confirmation, execution does not restart automatically, and a later `/execute` creates a fresh run.
- The busy acceptance proves ordering behind an active parent turn and existing follow-up.
- The lifecycle acceptance proves durable custom-compaction resume, cancellation without partial prepare, provider-failure state, and safe retry.
- The public extension API does not expose Prime Agent's strong descendant-RLM quiescence barrier. Slice 1 therefore does not claim that an idle parent with a running tracked RLM child is gated.
- Native RPC and ACP acceptance proves transport admission and shutdown but does not by itself prove `/reset` parity in every mode.
- Stable prompt-prefix bytes are not evidence of provider cache billing.

A release must report the descendant-RLM gap rather than treating it as passed evidence.
