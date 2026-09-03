# prime-ralph

`prime-ralph` is an opt-in [Prime Agent](https://github.com/PrimeIntellect/prime-agent) extension for running Ralph-style development work in one durable session.

It provides the coordination pieces that a Ralph loop needs without owning a host application, a repository, or a model provider:

- protect a cycle boundary before compaction;
- replace the compacted context with a deterministic bootstrap summary;
- restore exactly one continuation after compaction settles;
- recover safely from cancellation, provider errors, and stale continuation state;
- load project-provided phase skills;
- coordinate Beads ownership and evidence-backed checkpoints; and
- expose diagnostics without writing transcript or objective content to logs.

This package is deliberately small and host-neutral. It does not start an agent, choose a repository, invoke `bd`, or enable lifecycle behavior by default. The default extension export is a no-op. Hosts opt into the tested seams and provide their own adapters.

## Requirements

- Node.js 20 or newer
- Prime Agent `>=0.8.0 <0.9.0` as a peer dependency
- Beads (`bd`) only when using the Beads adapter or coordination runtime

## Install and load

Install the package alongside Prime Agent, then pass the extension entry point to the host:

```sh
npm install prime-ralph
prime-agent --extension node_modules/prime-ralph/src/index.js
```

The default export intentionally changes nothing. To use lifecycle coordination, import the factory and enable it explicitly:

```js
import { createRalphExtension } from "prime-ralph/ralph-extension";

const extension = createRalphExtension({
  enabled: true,
  bootstrapInstructions: "Keep the next cycle focused on the active task."
});
```

When Ralph owns continuation, automatic Prime Agent goals must be disabled unless the host supplies an explicit ownership handoff. The factory rejects unsupported Prime Agent versions before registering hooks.

## Choose an entry point

| Need | Entry point |
| --- | --- |
| Lifecycle extension | `prime-ralph/ralph-extension` |
| Cycle boundary and compaction predicate | `prime-ralph/cycle-boundary-poc` |
| Context projection | `prime-ralph/ralph-context` |
| Continuation admission | `prime-ralph/continuation-adapter` |
| Cycle state and recovery | `prime-ralph/cycle-coordinator` |
| Phase skills | `prime-ralph/skill-config` |
| Beads ownership and gates | `prime-ralph/beads-coordination` and `prime-ralph/coordination-runtime` |
| Diagnostics | `prime-ralph/diagnostics` |
| Observability | `prime-ralph/observability` and `prime-ralph/observability-extension` |

The package root exports the main tested seams. The full export map is in `package.json`.

## Development

```sh
npm install
npm test
npm run compat
npm run package:check
```

`npm test` runs the unit and fixture tests. `compat` checks the installed Prime Agent source/API contract. `package:check` validates the packed artifact and the behavior-neutral extension entry point.

## Reproduce research and transport checks

The source and session POCs require paths to a local Prime Agent installation:

```sh
PRIME_AGENT_SOURCE_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run poc:compaction-order
```

Native transport checks are separate from unit tests:

```sh
npm run poc:native-rpc
npm run poc:native-acp
npm run poc:native-acp-prompt
```

Run them in a disposable host session. Use strict LF-delimited JSONL, a unique daemon socket, and protocol shutdown. Text mode requires a pseudo-terminal. See [`docs/native-transport-acceptance.md`](docs/native-transport-acceptance.md).

## Documentation

- [`docs/README.md`](docs/README.md) — documentation map and recommended reading order
- [`docs/research-slice-2.md`](docs/research-slice-2.md) — source observations, assumptions, and executable POCs
- [`docs/release-contract.md`](docs/release-contract.md) — package, lifecycle, and release guarantees
- [`docs/native-transport-acceptance.md`](docs/native-transport-acceptance.md) — native transport evidence and limits

## Design boundaries

`prime-ralph` is an extension library, not a complete Ralph runner. It does not prescribe a repository layout, project skills, Beads schema, provider, deployment model, or user interface. Those belong to the host. The package preserves this boundary so it can be embedded without importing unrelated policy or operational assumptions.

## Status

The tested coordination, lifecycle, recovery, skills, Beads, diagnostics, packaging, compatibility, and native transport seams are available. Lifecycle behavior remains opt-in, and transport smoke tests are evidence of protocol integration rather than a claim that every host mode is production-ready.

## License

MIT. See [`LICENSE`](LICENSE).
