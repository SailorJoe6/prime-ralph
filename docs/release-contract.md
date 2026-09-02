# prime-ralph release and integration contract

## Package

The package requires Node.js 20 or newer and declares a peer dependency on Prime Agent `>=0.8.0 <0.9.0`. Install it as an opt-in extension dependency. The package includes `src/`, reproducibility scripts, and research evidence docs.

Validate a release locally:

```sh
npm test
npm run compat
npm run package:check
npm pack --dry-run
```

A clean-install smoke test should extract the tarball and import `src/index.js` before publishing. `package:check` also invokes the behavior-neutral entry point for text, JSON, RPC, ACP, and daemon mode labels; this is an import smoke test, not a claim of full mode-specific runtime support.

## Runtime safety

The default extension entry point is behavior-neutral. Ralph-managed sessions must disable Prime Agent automatic goals unless the host provides an explicit ownership handoff. Requested compaction requires explicit continuation admission after compaction settles. Never infer provider cache billing from common prompt-prefix bytes.

## Optional control-repository integration

A consumer may add this repository as `deps/prime-ralph` after a standalone release is created. The consumer should pin a deliberate release commit and keep the dependency outside OpenClaw runtime configuration. Submodule initialization from a clean clone is an acceptance check.


## Beads cycle execution

The coordination runtime claims an issue, evaluates configured phase gates, and writes a bounded checkpoint only when all gates pass and durable evidence exists. The `bd` adapter remains the transaction boundary; callers must provide a real adapter backed by the target repository's Beads database.


The package root exports the tested coordinator, continuation, skill, Beads, lifecycle, and diagnostics seams while its default extension remains a no-op. This makes the current research components consumable without falsely enabling unvalidated host lifecycle behavior.


`startManagedCycle()` is the narrow orchestration entry point for consumers: it runs claim, configured gates, and evidence checkpointing through an injected `bd` adapter, then returns only ownership metadata and bounded results. It does not bypass Beads transactions or claim issue completion implicitly.


## Opt-in lifecycle factory

`createRalphExtension({ enabled: true })` is the first host-facing lifecycle factory. It requests one compaction at a final normal assistant turn with an active goal, returns a fixed `RALPH_BOOTSTRAP:` summary using the host-provided valid boundary, and schedules one explicit `goal_context` follow-up after compaction. It must be used with automatic Prime Agent goals disabled, as established by the coexistence POC. The default export remains disabled/no-op until broader host integration is validated.


The real `poc:session-factory` fixture loads `createRalphExtension({ enabled: true })` into AgentSession with automatic goals disabled. Against Prime Agent 0.8.0 it completes two provider calls, persists the fixed bootstrap compaction, persists one goal context, and reaches `agent_end`.


`npm run poc:mode-matrix` registers the lifecycle factory for text, JSON, RPC, ACP, and daemon labels. It verifies hook registration only; it does not substitute for native host transport acceptance.


The lifecycle factory validates its options and caps custom bootstrap instructions at 4,000 characters before they enter compaction instructions or persisted summaries. This bounds configuration-driven prompt growth.


When the host supplies its detected Prime Agent version, the lifecycle factory rejects versions outside `>=0.8.0 <0.9.0` before registering hooks.


`npm run poc:native-rpc` starts the native Prime Agent RPC transport with the packaged extension and sends the documented `abort` command, verifying deterministic JSONL command admission and clean exit. A full prompt/response RPC run needs a provider session and is not implied by this smoke.


`npm run poc:native-acp` starts ACP mode with the packaged extension, performs JSON-RPC `initialize` and `session/new`, validates Prime Agent 0.8.0 protocol/session responses, and exits cleanly at EOF. Prompt streaming remains outside this bounded smoke.
