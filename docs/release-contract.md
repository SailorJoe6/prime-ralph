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

A clean-install smoke test should extract the tarball and import `src/index.js` before publishing.

## Runtime safety

The default extension entry point is behavior-neutral. Ralph-managed sessions must disable Prime Agent automatic goals unless the host provides an explicit ownership handoff. Requested compaction requires explicit continuation admission after compaction settles. Never infer provider cache billing from common prompt-prefix bytes.

## Optional control-repository integration

A consumer may add this repository as `deps/prime-ralph` after a standalone release is created. The consumer should pin a deliberate release commit and keep the dependency outside OpenClaw runtime configuration. Submodule initialization from a clean clone is an acceptance check.


## Beads cycle execution

The coordination runtime claims an issue, evaluates configured phase gates, and writes a bounded checkpoint only when all gates pass and durable evidence exists. The `bd` adapter remains the transaction boundary; callers must provide a real adapter backed by the target repository's Beads database.


The package root exports the tested coordinator, continuation, skill, Beads, lifecycle, and diagnostics seams while its default extension remains a no-op. This makes the current research components consumable without falsely enabling unvalidated host lifecycle behavior.


`startManagedCycle()` is the narrow orchestration entry point for consumers: it runs claim, configured gates, and evidence checkpointing through an injected `bd` adapter, then returns only ownership metadata and bounded results. It does not bypass Beads transactions or claim issue completion implicitly.
