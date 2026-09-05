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

## Continuation closeout ordering

Prime Agent can make a native goal continuation available after it stores the pass's final assistant message but before the queued `turn_end` extension handler runs. When the normal final assistant message is immediately adjacent to that continuation, Ralph holds provider admission until its own queued closeout handler settles. The handler durably records the pending Continue decision. The waiting context hook then writes the execution log entry, advances the cycle, and admits the continuation without aborting the host input pump. A continuation with no immediately adjacent normal assistant closeout still fails closed.

This removes any dependency on `turn_end` winning an asynchronous scheduling race while retaining the established closeout and failure-injection path. It also prevents an already-consumed continuation from leaving an active native goal parked until unrelated user or child traffic wakes the session.

## Durable execution-boundary projection

Once a matching native continuation is admitted, its persisted `goalId:continuationsUsed`, lifecycle, and cycle record owns the provider boundary for the whole round. Projection no longer depends on the continuation being newer than the latest user message. Every later provider call reconstructs the same `prepare`-then-`execute` boundary, removes all earlier conversation, and retains every message after the matching `goal_context`, including ordinary steering, `/btw`, queued user input, tracked-child notices, and tool-call/result tails.

The admitted record survives extension reload. Ralph reconstructs the execution injection from durable lifecycle state and the matching retained `goal_context`; it does not advance the cycle or append the previous execution log again. A newer distinct goal continuation still goes through the normal identity and lifecycle checks rather than being hidden by the prior boundary.

This is the immediate safety half of the selected hybrid design. A later increment will add one correlated public-API custom compaction at initial continuation admission, with exact-once recovery after the compaction aborts that host turn. Until that is proven, durable projection remains the provider-facing boundary and no compaction behavior has changed.

## Terminal execution-log recovery

A blocked or completed pass now records its final assistant message and timestamp in the lifecycle state before it writes `.ralph/logs/EXECUTION_LOG.md`. The terminal closeout clears that intent only after the log append succeeds.

If the log append fails, reload or the next same-session workflow transition retries the durable intent before it changes lifecycle state or admits another phase prompt. If the log append succeeds but the following state append fails, recovery may attempt the same log entry again. The execution log's semantic entry identity includes the session, Ralph lifecycle, terminal action, phase, cycle, and final message, so a retry is idempotent without collapsing a later lifecycle that happens to reuse the same cycle number and text. An incomplete or textless terminal intent fails closed instead of being silently erased. This ordering preserves the completed pass across either failure without reopening execution, duplicating the lifecycle, or relying on transcript reconstruction.

## Remaining durability work

Later increments still need failure injection around other state-append positions, driver stop, readiness, and the file transactions that are not already covered. Reset races must also be repeated across extension reload. Each increment must leave a failed operation either safely retryable or durably terminal and must preserve the session JSONL and REPL state.
