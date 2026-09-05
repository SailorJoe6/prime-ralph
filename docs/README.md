# Documentation guide

This directory documents the standalone `prime-ralph` package. Start with the root [`README.md`](../README.md) for installation and the shortest path to a working check.

## Recommended reading order

1. **[Project initialization](initialization.md)** — Slice 2 project-local setup, templates, conflict behavior, Beads, and stealth mode.
2. **[Interactive specification workflow](specification.md)** — Slice 3 startup, `/spec-it-out`, trusted invocation facts, and behavioral evidence.
3. **[Interactive planning workflow](planning.md)** — Slice 4 startup, `/plan`, phase-aware reset, and behavioral evidence.
4. **[Safe execution lifecycle](execution.md)** — ownership hierarchy, cycles, provider/tool loops, native-goal continuation, waiting, blocked and manually restored recovery, and logging.
5. **[`/reset` context boundary](reset.md)** — compaction, repeated provider-call projection, evidence, and host API gap.
6. **[Release contract](release-contract.md)** — what the package guarantees, what it leaves to the host, and how to validate a release.
7. **[Research slice 2](research-slice-2.md)** — historical lifecycle observations and POCs.
8. **[Native transport acceptance](native-transport-acceptance.md)** — historical transport checks and their limits.

## Documentation roles

| Document | Use it when you need to… |
| --- | --- |
| [`README.md`](../README.md) | install, load, test, or find an entry point |
| [`initialization.md`](initialization.md) | initialize one project without overwriting its content |
| [`specification.md`](specification.md) | understand startup, `/spec-it-out`, compatibility, and behavioral evidence |
| [`planning.md`](planning.md) | understand planning startup, `/plan`, phase tracking, reset, and evidence |
| [`execution.md`](execution.md) | understand the workflow hierarchy, automatic cycles, tool loops, waiting, and blocked recovery |
| [`reset.md`](reset.md) | understand or validate the production `/reset` path |
| [`release-contract.md`](release-contract.md) | review compatibility and release criteria |
| [`research-slice-2.md`](research-slice-2.md) | understand source findings and POCs |
| [`native-transport-acceptance.md`](native-transport-acceptance.md) | reproduce or assess native transport evidence |

## Scope

These documents describe a reusable Prime Agent extension. Host-specific repository policy, deployment instructions, provider credentials, and operational runbooks do not belong here. A host supplies those separately through adapters, configuration, and skills.

## Evidence vocabulary

- **Unit test** — verifies a package function in isolation.
- **Fixture POC** — exercises a lifecycle seam with a deterministic or in-memory host.
- **Compatibility check** — verifies assumptions against an installed Prime Agent source/API.
- **Native smoke** — verifies protocol admission and shutdown through a real host transport.
- **Real-model behavioral acceptance** — observes a selected provider/model acting on the exact delivered prompt under a restricted tool surface.

Passing one level does not imply that the next level has passed.
