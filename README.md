# prime-ralph

`prime-ralph` is a standalone, project-local [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) extension for Ralph-style development workflows in one durable session.

The current release wedge implements interactive specification startup, `/spec-it-out`, and specification-aware `/reset`. It does not expose planning or execution commands.

## Slice 1 behavior

When the user invokes `/reset`, the extension:

1. reads only `.ralph/skills/prepare/SKILL.md` from the current project;
2. validates the file before recording a reset boundary;
3. appends a non-model-visible marker and asks Prime Agent to compact to that real entry ID;
4. supplies an empty extension compaction, removes only its fixed wrapper, then schedules one hidden durable prepare message;
5. uses the same prepare-message projection as an exactness guard and as the fallback when Prime Agent reports that the session is too short to compact; and
6. leaves the host system prompt, session identity, JSONL history, and Prime Agent-owned REPL state unchanged.

The exactness guard remains active through tool continuations and later conversation. It prevents Prime Agent-restored host artifacts as well as ordinary stale user, assistant, and tool messages from returning to the provider. Pending `/reset` commands follow Prime Agent's normal input-queue cancellation behavior; once the handler starts, reset wins that race.

When no active specification exists, `/reset` remains prepare-only. When an active regular specification exists, the same reset boundary contains `prepare` first and `spec-it-out` second in `specification-reset-existing` mode. The command does not start planning, a goal, or autonomous continuation.

Prime Agent's built-in `/clear` remains unchanged. In Prime Agent `0.9.1`, `/clear` is an alias for `/new`; `prime-ralph` deliberately uses the non-colliding `/reset` name instead of shadowing native behavior.

## Slice 3 specification behavior

In a real session with no active specification, the extension delivers `prepare` exactly once before ordinary interaction. The durable boundary is keyed to the current session, so `/reload` does not replay it and a fork is not suppressed by an inherited parent marker.

`/spec-it-out` keeps the current conversation. Code classifies the exact `.ralph/plans/SPECIFICATION.md` path and supplies a closed, versioned invocation mode. The project skill owns questions, warnings, future/update/cancel choices, consent, and document writing. The handler never writes a planning document. Parent or destination symlinks and unsupported path types fail before prompt delivery.

Only `/reset` and `/spec-it-out` are registered. `/plan` and `/execute` remain unavailable.

## Requirements

- Node.js 20 or newer
- Prime Agent `0.9.1`
- A project skill at `.ralph/skills/prepare/SKILL.md`

The prepare and `spec-it-out` skills must be valid UTF-8, have strict YAML frontmatter with matching names and non-empty descriptions, have non-empty bodies, and be no larger than 128 KiB. The `spec-it-out` skill must declare `prime-ralph-invocation-version: 1`; this prevents an older project-local prompt from silently guessing Slice 3 state. Duplicate YAML keys are rejected.

## Install and initialize a project

Package installation and project initialization are separate. After installing `prime-ralph` alongside Prime Agent, opt one project in explicitly:

```sh
cd /path/to/project
prime-ralph init
```

The initializer creates only missing project structure. It installs a project-local extension directory symlink under `.prime/agent/extensions/`, five canonical skills under `.ralph/skills/`, and matching Prime Agent skill links under `.agents/skills/`. A normal `prime-agent` launch in that project then discovers the extension automatically; no `--extension` flag is required.

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
/reset
```

The package contains no host-specific repository, provider, deployment, or task policy. Project skill files provide model instructions; the extension supplies mechanics only. See [`docs/initialization.md`](docs/initialization.md).

## Public entry points

| Need | Entry point |
| --- | --- |
| Production Slice 3 extension | `prime-ralph` |
| Workflow extension factory | `prime-ralph/workflow-extension` |
| Specification state and invocation helpers | `prime-ralph/specification` |
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
npm run accept:reset-busy
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:reset-lifecycle
PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 \
PRIME_RALPH_ACCEPT_PROVIDER=openai-codex \
PRIME_RALPH_ACCEPT_MODEL=gpt-5.6-sol \
npm run accept:model:spec-it-out -- --variant all --case all
npm run package:check
npm pack --dry-run
```

The reset disk-backed acceptance uses a deterministic provider and a real Prime Agent IPython kernel. It proves stale provider messages are removed while the session ID, JSONL path/history, system baseline, and REPL value survive. The specification acceptance uses a deterministic provider and real Prime Agent `0.9.1` extension lifecycle to prove startup ordering, reload suppression, context preservation, invocation modes, and reset projection. The opt-in model acceptance is separate behavioral evidence and never runs as part of `npm test`. The busy acceptance proves a reset queues behind active work and an existing follow-up, and that a duplicate pending request produces only one boundary.

## Current public-API boundary

Prime Agent `0.9.1` exposes `isIdle()`, `hasPendingMessages()`, and follow-up admission to extension commands. The extension uses the host queue instead of timing or response-text heuristics.

Prime Agent does not expose its stronger descendant-RLM quiescence barrier through `ExtensionCommandContext`. Therefore Slice 1 cannot yet prove that `/reset` waits for a still-running tracked RLM child when the parent session itself is idle. Arbitrary detached work is also outside automatic detection. See [`docs/reset.md`](docs/reset.md) for the exact evidence boundary.

## Documentation

- [`docs/specification.md`](docs/specification.md) — startup, `/spec-it-out`, prompt compatibility, and behavioral evidence
- [`docs/reset.md`](docs/reset.md) — command contract, state and context design, tests, and known host API gap
- [`docs/release-contract.md`](docs/release-contract.md) — package and validation contract
- [`docs/research-slice-2.md`](docs/research-slice-2.md) — historical source observations and POCs
- [`docs/native-transport-acceptance.md`](docs/native-transport-acceptance.md) — historical transport evidence and limits

## License

MIT. See [`LICENSE`](LICENSE).
