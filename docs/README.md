# Documentation guide

This directory documents the standalone `prime-ralph` package. Start with the root [`README.md`](../README.md) for installation and the shortest path to a working check.

## Recommended reading order

1. **[`/reset` context boundary](reset.md)** — current Slice 1 behavior, mechanics, evidence, and host API gap.
2. **[Release contract](release-contract.md)** — what the package guarantees, what it leaves to the host, and how to validate a release.
3. **[Research slice 2](research-slice-2.md)** — historical lifecycle observations and POCs.
4. **[Native transport acceptance](native-transport-acceptance.md)** — historical transport checks and their limits.

## Documentation roles

| Document | Use it when you need to… |
| --- | --- |
| [`README.md`](../README.md) | install, load, test, or find an entry point |
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

Passing one level does not imply that the next level has passed.
