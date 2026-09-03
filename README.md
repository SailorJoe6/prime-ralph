# prime-ralph

`prime-ralph` is a standalone, project-local [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) extension for Ralph-style development workflows in one durable session.

The current release wedge implements a phase-unaware `/reset` command. It creates a fresh provider-visible context without starting, switching, forking, or replacing the Prime Agent session.

## Slice 1 behavior

When the user invokes `/reset`, the extension:

1. reads only `.ralph/skills/prepare/SKILL.md` from the current project;
2. validates the file before recording a reset boundary;
3. appends a non-model-visible marker and asks Prime Agent to compact to that real entry ID;
4. supplies an empty extension compaction, removes only its fixed wrapper, then schedules one hidden durable prepare message;
5. uses the same prepare-message projection as an exactness guard and as the fallback when Prime Agent reports that the session is too short to compact; and
6. leaves the host system prompt, session identity, JSONL history, and Prime Agent-owned REPL state unchanged.

The exactness guard remains active through tool continuations and later conversation. It prevents Prime Agent-restored host artifacts as well as ordinary stale user, assistant, and tool messages from returning to the provider. Pending `/reset` commands follow Prime Agent's normal input-queue cancellation behavior; once the handler starts, reset wins that race.

`/reset` does not inspect Ralph planning files, choose a phase, start a goal, enable autonomous continuation, or inject any phase skill. Those behaviors belong to later workflow slices.

Prime Agent's built-in `/clear` remains unchanged. In Prime Agent `0.9.1`, `/clear` is an alias for `/new`; `prime-ralph` deliberately uses the non-colliding `/reset` name instead of shadowing native behavior.

## Requirements

- Node.js 20 or newer
- Prime Agent `0.9.1`
- A project skill at `.ralph/skills/prepare/SKILL.md`

The prepare skill must be valid UTF-8, contain valid YAML frontmatter whose mapping declares `name: prepare` and a non-empty `description`, have a non-empty body, and be no larger than 128 KiB. Duplicate YAML keys are rejected.

## Install and load

Install the package alongside Prime Agent and load its default extension:

```sh
npm install prime-ralph
prime-agent --extension node_modules/prime-ralph/src/index.js
```

Then invoke:

```text
/reset
```

The package contains no host-specific repository, provider, deployment, or task policy. Project skill files provide model instructions; the extension supplies only reset mechanics.

## Public entry points

| Need | Entry point |
| --- | --- |
| Production Slice 1 extension | `prime-ralph` |
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
npm run accept:reset-busy
PRIME_AGENT_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run accept:reset-lifecycle
npm run package:check
npm pack --dry-run
```

The disk-backed acceptance uses a deterministic provider and a real Prime Agent IPython kernel. It proves stale provider messages are removed while the session ID, JSONL path/history, system baseline, and REPL value survive. The busy acceptance proves a reset queues behind active work and an existing follow-up, and that a duplicate pending request produces only one boundary.

## Current public-API boundary

Prime Agent `0.9.1` exposes `isIdle()`, `hasPendingMessages()`, and follow-up admission to extension commands. The extension uses the host queue instead of timing or response-text heuristics.

Prime Agent does not expose its stronger descendant-RLM quiescence barrier through `ExtensionCommandContext`. Therefore Slice 1 cannot yet prove that `/reset` waits for a still-running tracked RLM child when the parent session itself is idle. Arbitrary detached work is also outside automatic detection. See [`docs/reset.md`](docs/reset.md) for the exact evidence boundary.

## Documentation

- [`docs/reset.md`](docs/reset.md) — command contract, state and context design, tests, and known host API gap
- [`docs/release-contract.md`](docs/release-contract.md) — package and validation contract
- [`docs/research-slice-2.md`](docs/research-slice-2.md) — historical source observations and POCs
- [`docs/native-transport-acceptance.md`](docs/native-transport-acceptance.md) — historical transport evidence and limits

## License

MIT. See [`LICENSE`](LICENSE).
