# Safe execution lifecycle

Slice 5 adds `/execute` as the explicit entry to one automatic Ralph lifecycle. The extension is the durable authority for lifecycle identity and the `inactive`, `running`, `waiting`, and `paused` states. Prime Agent's native thread goal is the sole continuation driver.

## Driver contract

`/execute` accepts only the exact regular files `.ralph/plans/SPECIFICATION.md` and `.ralph/plans/EXECUTION_PLAN.md`. It refuses blocked state, a duplicate lifecycle, and an unrelated active or paused native goal. The first injected `execute` skill creates the native goal through the public `goal` skill. Later goal continuations are projected into a clean `prepare`-then-`execute` boundary for the same lifecycle.

This constrained mapping uses Prime Agent `0.9.1`'s native tracked-descendant RLM quiescence barrier. The extension does not run a second continuation loop. Plugin-owned versioned session markers remain authoritative because the public extension API cannot directly control or inspect the native goal.

Every pass must call the sequential `ralph_lifecycle` tool with current lifecycle and cycle identifiers. `turn_end`, prose, errors, elapsed time, and issue counts never select a transition. Missing or stale signals fail closed to `paused`.

- `continue` requires the native goal to remain active. It advances one cycle only after normal pass closeout.
- `wait` requires the skill to complete the native goal first and records bounded readiness evidence. It keeps the cycle and context open.
- `ready` requires the current wait identifier and a newly created native goal. It resumes the same lifecycle and cycle once.
- `block` requires the native goal to be complete and wakeups to be stopped.
- `complete` requires the native goal to be complete. Archival is optional and explicit.

Native `/goal pause`, `/goal resume`, and `/goal clear` pause, resume, and cancel the mapped lifecycle. A resumed goal must match the lifecycle's recorded driver identity. `/execute` never creates another lifecycle while one is running, waiting, or paused.

## Waiting and reset

Tracked RLM work is held by the native goal driver until descendants settle. Work that the host cannot observe uses the explicit `wait`/`ready` protocol and, when needed, one agent-owned heartbeat or user response. A waiting check is not an execute pass and is not logged.

`/reset` has state-specific behavior:

- running: record a request for the next eligible boundary;
- waiting: preserve the open cycle and warn that reset is deferred;
- paused: create a clean `prepare`-then-`execute` boundary with `triggerTurn:false`;
- blocked: create a clean `prepare`-then-`blocked` interaction.

## Blocked transactions

Blocking and unblocking move the exact specification/plan pair without overwrite. Preflight rejects symlinks, non-regular files, unreal parents, partial pairs, stale provenance, and destination conflicts. The transaction uses no-replace moves, a versioned provenance marker, and rollback on second-move or marker failure. Unrelated blocked and archive files are preserved.

Only a complete current provenance marker establishes blocked state. The first user reply after blocking receives a clean blocked boundary while preserving that reply. Unblock restores both active files but leaves execution inactive. The blocked skill must then confirm forward readiness. A new explicit `/execute` creates a fresh lifecycle.

Completion does not force archive. When the project skill requests archive, both active documents move to one safe named directory under `.ralph/plans/archive/<name>/`.

## Execution log

Completed execute passes append to the fixed file:

```text
.ralph/logs/EXECUTION_LOG.md
```

The writer safely creates a missing real `.ralph/logs` directory, rejects symlinks and incompatible path types, and never truncates the file. It writes one header at the start of each contiguous session section and deduplicated entries with UTC timestamp, phase, cycle, and quoted final assistant message. Waiting checks and interactive specification, planning, or blocked turns are not logged.

## Evidence

Deterministic tests cover lifecycle reduction and recovery, one-shot clean projection with retained tool tails, queued input, command gating, native goal reconciliation, stale signals, waiting/readiness, every reset branch, provider failure, block/unblock/archive transactions and rollback, content-hash provenance, and append-only logging. The disk-backed Prime Agent `0.9.1` acceptance proves three rounds, a held tracked-RLM boundary, clean skill ordering, tool-result retention, completed-pass logging, and stable session, JSONL, and REPL identity. Separate controlled-model acceptance proves the public `goal.create`/`goal.complete` path and semantic completion through `ralph_lifecycle`.
