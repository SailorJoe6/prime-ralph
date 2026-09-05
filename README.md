# prime-ralph

`prime-ralph` is a standalone, project-local [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) extension for Ralph-style development workflows in one durable session.

The current release implements interactive specification and planning plus a safe `/execute` lifecycle with native-goal continuation, waiting, pause/resume, blocked recovery, optional archival, and append-only execution logging.

## Slice 1 behavior

When the user invokes `/reset`, the extension:

1. reads only `.ralph/skills/prepare/SKILL.md` from the current project;
2. validates the file before recording a reset boundary;
3. appends a non-model-visible marker and asks Prime Agent to compact to that real entry ID;
4. supplies an empty extension compaction, removes only its fixed wrapper, then schedules one hidden durable prepare message;
5. uses the same prepare-message projection as an exactness guard and as the fallback when Prime Agent reports that the session is too short to compact; and
6. leaves the host system prompt, session identity, JSONL history, and Prime Agent-owned REPL state unchanged.

The exactness guard remains active through tool continuations and later conversation. It prevents Prime Agent-restored host artifacts as well as ordinary stale user, assistant, and tool messages from returning to the provider. Pending `/reset` commands follow Prime Agent's normal input-queue cancellation behavior; once the handler starts, reset wins that race.

In specification phase, `/reset` remains prepare-only until an active specification appears; after that it delivers `prepare` followed by `spec-it-out` in `specification-reset-existing` mode. In planning phase, it delivers `prepare` followed by `plan` in the matching reset mode. The command preserves phase and never starts execution, a goal, or autonomous continuation.

Prime Agent's built-in `/clear` remains unchanged. In Prime Agent `0.9.1`, `/clear` is an alias for `/new`; `prime-ralph` deliberately uses the non-colliding `/reset` name instead of shadowing native behavior.

## Slice 3 specification behavior

In a real session with no active specification, the extension delivers `prepare` exactly once before ordinary interaction. The durable boundary is keyed to the current session, so `/reload` does not replay it and a fork is not suppressed by an inherited parent marker.

`/spec-it-out` keeps the current conversation. Code classifies the exact `.ralph/plans/SPECIFICATION.md` path and supplies a closed, versioned invocation mode. The project skill owns questions, warnings, future/update/cancel choices, consent, and document writing. The handler never writes a planning document. Parent or destination symlinks and unsupported path types fail before prompt delivery.

## Slice 4 planning behavior

A session that starts with an active specification enters interactive planning. It delivers one ordered `prepare`-then-`plan` message and supplies authoritative metadata for whether the exact active execution plan exists. An explicit `/plan` transition from specification phase uses the same clean context boundary. Once planning is established, `/plan` with an existing plan keeps the current conversation for discussion.

The command handler never creates or edits an execution plan. The project `plan` skill owns creation, warnings, discussion, explicit update consent, and cancellation. Only the exact `.ralph/plans/EXECUTION_PLAN.md` regular file is active; nested and conflicting paths do not activate it. Control-path symlinks are detected without being followed and produce a path-specific error with replacement-or-removal guidance.

`/reset`, `/spec-it-out`, `/plan`, and `/execute` are registered. Execution remains inactive until a valid explicit `/execute`.


## Slice 5 execution behavior

A valid `/execute` starts one automatic execution run and creates a clean `prepare`-then-`execute` boundary. Prime Agent's native goal starts later agent turns and waits for tracked RLM children. `prime-ralph` records which goal belongs to the run, the current logical cycle, and whether execution is running, waiting, or paused. The model must call the `ralph_lifecycle` tool to continue, wait, block, or complete; a normal response or `turn_end` is not treated as a decision.

Each next cycle receives a clean model-visible context while the Prime Agent session, JSONL history, and REPL remain intact. The execute skill sizes that cycle as one small publishable evidence increment, requires an exit condition and exclusions before edits, and reserves closeout budget rather than treating one broad feature as one task. Blocking moves the exact specification and plan together. If a user moves those files back manually, Ralph verifies them and guides the model through the original unblock condition instead of asking the user to move them again. Execution still restarts only through a later explicit `/execute`. See [`docs/execution.md`](docs/execution.md) for the work-unit sizing gate, state hierarchy, provider/tool loop, context boundaries, waiting, recovery, optional archival, and `.ralph/logs/EXECUTION_LOG.md`.

## Requirements

- Node.js 20 or newer
- Prime Agent `0.9.1`
- A project skill at `.ralph/skills/prepare/SKILL.md`

The prepare, `spec-it-out`, `plan`, `execute`, and `blocked` skills must be valid UTF-8, have strict YAML frontmatter with matching names and non-empty descriptions, have non-empty bodies, and be no larger than 128 KiB. The four versioned phase skills must declare `prime-ralph-invocation-version: 1`; this prevents older project-local prompts from silently guessing plugin-owned state. Duplicate YAML keys are rejected.

## Install and initialize a project

Package installation and project initialization are separate. After installing `prime-ralph` alongside Prime Agent, opt one project in explicitly:

```sh
cd /path/to/project
prime-ralph init
```

The initializer creates only missing project structure. It installs a project-local extension directory symlink under `.prime/agent/extensions/` and five canonical internal prompts under `.ralph/skills/`. It does not expose those prompts through `.agents/skills/`, because direct skill commands would bypass plugin-authored state and duplicate the Ralph extension commands in autocomplete. Re-running initialization removes only exact legacy Ralph skill symlinks and preserves every other entry. A normal `prime-agent` launch then discovers the extension automatically; no `--extension` flag is required.

Optional initialization modes are:

```sh
prime-ralph init --project /path/to/project
prime-ralph init --beads
prime-ralph init --stealth
```

`--beads` is the only way to select Beads-aware templates. `--stealth` adds only artifacts created by that invocation to the Git worktree's local exclude file. Repeated initialization preserves existing skills, plans, logs, links, extension entries, and other project content. Package updates never run initialization or refresh project files.

After initialization, start Prime Agent in the project. With no active specification, `prepare` runs automatically once. Use:

```text
/spec-it-out
/plan
/execute
/reset
```

The package contains no host-specific repository, provider, deployment, or task policy. Project skill files provide model instructions; the extension supplies mechanics only. See [`docs/initialization.md`](docs/initialization.md).

## Public entry points

| Need | Entry point |
| --- | --- |
| Production workflow extension | `prime-ralph` |
| Workflow extension factory | `prime-ralph/workflow-extension` |
| Specification state and invocation helpers | `prime-ralph/specification` |
| Planning state and invocation helpers | `prime-ralph/planning` |
| Execution lifecycle and context helpers | `prime-ralph/execution` |
| Block, unblock, and archive transactions | `prime-ralph/planning-transaction` |
| Append-only execution log | `prime-ralph/execution-log` |
| Reset extension factory | `prime-ralph/reset-extension` |
| Prepare validation and injection | `prime-ralph/reset-skill` |
| Provider-context projection | `prime-ralph/reset-context` |
| Historical POC seams | Other exports listed in `package.json` |

Historical lifecycle, compaction, continuation, phase, Beads, and transport modules remain POC evidence. They are not enabled by the default extension and are not implementation authority for the current workflow.

## Development and acceptance

```sh
npm test
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
PRIME_RALPH_ACCEPT_PROVIDER=openai-codex \
PRIME_RALPH_ACCEPT_MODEL=gpt-5.6-sol \
npm run accept:model:spec-it-out -- --variant all --case all
PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 \
PRIME_RALPH_ACCEPT_PROVIDER=openai-codex \
PRIME_RALPH_ACCEPT_MODEL=gpt-5.6-sol \
npm run accept:model:plan -- --variant all --case all
PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 \
PRIME_RALPH_ACCEPT_PROVIDER=openai-codex \
PRIME_RALPH_ACCEPT_MODEL=gpt-5.6-sol \
npm run accept:model:execute
PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 \
PRIME_RALPH_ACCEPT_PROVIDER=openai-codex \
PRIME_RALPH_ACCEPT_MODEL=gpt-5.6-sol \
npm run accept:model:blocked-recovery -- --variant all
npm run package:check
npm pack --dry-run
```

The reset disk-backed acceptance uses a deterministic provider and a real Prime Agent IPython kernel. It proves stale provider messages are removed while the session ID, JSONL path/history, system baseline, and REPL value survive. The specification acceptance uses a deterministic provider and real Prime Agent `0.9.1` extension lifecycle to prove startup ordering, reload suppression, context preservation, invocation modes, reset projection, and an unambiguous native command catalog without direct Ralph skill duplicates. Planning acceptance additionally proves startup and explicit transition, both planning reset branches, current-context existing-plan discussion, and plan protection. Execution acceptance proves three native-goal-driven rounds, clean boundaries, tracked-RLM deferral, completed-cycle logging, and stable session, JSONL, and REPL identity. Blocked-recovery acceptance uses the real filesystem and Prime Agent lifecycle to prove manually restored files are verified without being moved again, old context stays excluded through tool results, and execution waits for a later `/execute`. The opt-in model acceptances are separate behavioral evidence and never run as part of `npm test`. The busy acceptance proves a reset queues behind active work and an existing follow-up, and that a duplicate pending request produces only one boundary.

## Current public-API boundary

Prime Agent `0.9.1` exposes `isIdle()`, `hasPendingMessages()`, and follow-up admission to extension commands. The extension uses the host queue instead of timing or response-text heuristics.

Prime Agent does not expose its stronger descendant-RLM quiescence barrier through `ExtensionCommandContext`. Therefore Slice 1 cannot yet prove that `/reset` waits for a still-running tracked RLM child when the parent session itself is idle. Arbitrary detached work is also outside automatic detection. See [`docs/reset.md`](docs/reset.md) for the exact evidence boundary.

## Documentation

- [`docs/specification.md`](docs/specification.md) — startup, `/spec-it-out`, prompt compatibility, and behavioral evidence
- [`docs/planning.md`](docs/planning.md) — planning startup, `/plan`, phase tracking, reset behavior, and evidence
- [`docs/execution.md`](docs/execution.md) — execution driver, lifecycle, waiting, blocked transactions, and logs
- [`docs/reset.md`](docs/reset.md) — command contract, state and context design, tests, and known host API gap
- [`docs/release-contract.md`](docs/release-contract.md) — package and validation contract
- [`docs/research-slice-2.md`](docs/research-slice-2.md) — historical source observations and POCs
- [`docs/native-transport-acceptance.md`](docs/native-transport-acceptance.md) — historical transport evidence and limits

## License

MIT. See [`LICENSE`](LICENSE).
