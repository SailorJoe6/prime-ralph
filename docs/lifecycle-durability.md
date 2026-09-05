# Lifecycle durability

This document tracks durability work that extends the safe execution lifecycle without replacing its established ownership model.

## Shipped baseline retained

The existing workflow already stores versioned lifecycle records in the Prime Agent session JSONL and reconstructs state from the current branch. It retains one lifecycle identity across running, waiting, and paused states. The `ralph_lifecycle` tool owns explicit semantic transitions. Block and archive file moves use provenance and rollback. Manually restored blocked work uses a durable adoption intent. These mechanisms remain the baseline rather than being reimplemented as separate commands or a second state store.

The unified `ralph_lifecycle` tool is the selected explicit transition surface. Separate `ralph_wait`, `ralph_ready`, `ralph_block`, `ralph_unblock`, `ralph_complete`, or `ralph_status` tools would duplicate validation and increase the chance of inconsistent recovery. They are not adopted unless later evidence shows that the unified sequential tool cannot safely express a required transition.

## State-chain recovery rule

Lifecycle recovery treats the ordered state records for the current session as an authoritative chain:

- records for other session identities are ignored;
- every current-session record must satisfy the versioned lifecycle schema;
- each later retained record must have a strictly greater transition number;
- an invalid, stale, or duplicate record stops recovery instead of falling back to an older state or to an inactive lifecycle;
- the failure message is fixed and bounded. It does not include record contents, transcript text, paths, or credentials;
- extension reload sends no phase prompt after this failure.

A retained branch may begin at a transition greater than zero after compaction. The check therefore requires monotonic order, not contiguous numbering.

This rule prevents a corrupt or replayed newest record from resurrecting an older running state, admitting a second lifecycle, or silently dropping a waiting state.

## Remaining durability work

Later increments still need failure injection around state append, log append, driver stop, readiness, and the file transactions that are not already covered. Reset races must also be repeated across extension reload. Each increment must leave a failed operation either safely retryable or durably terminal and must preserve the session JSONL and REPL state.
