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

Tracked RLM work can end one Agent run and deliver its terminal message in another while the same native goal remains active. Ralph re-registers every reconciled running execution at `before_agent_start`, so the later normal `turn_end` still owns lifecycle closeout. The closeout fence also remembers a matching event that settled before waiter registration. If neither ordering produces a durable closeout within 30 seconds, or the Agent run ends or the session shuts down, Ralph releases the waiter and pauses instead of leaving provider admission hung indefinitely.

This removes any dependency on `turn_end` winning an asynchronous scheduling race while retaining the established closeout and failure-injection path. It also prevents an already-consumed continuation from leaving an active native goal parked until unrelated user or child traffic wakes the session.

## Durable hybrid execution boundary

Once a matching native continuation is admitted, its persisted `goalId:continuationsUsed`, lifecycle, and cycle record owns the provider boundary for the whole round. Projection no longer depends on the continuation being newer than the latest user message. Every later provider call reconstructs the same `prepare`-then-`execute` boundary, removes all earlier conversation, and retains every message after the matching `goal_context`, including ordinary steering, `/btw`, queued user input, tracked-child notices, and tool-call/result tails.

At initial continuation admission, Ralph now appends a dedicated non-model-visible marker and journals its exact session, lifecycle, cycle, native goal, continuation count, and boundary identity. One request-scoped `ctx.compact()` then uses that real marker as `firstKeptEntryId`. The provider projection is returned before the fire-and-forget request, so it remains the guard if provider admission and the compaction-triggered abort are adjacent. The handler accepts only the execution-specific instruction namespace and exact durable marker. It cannot match `/reset` or an ordinary compaction.

Prime Agent `0.9.1` aborts the active Agent run for public compaction. Ralph first defers the optional request when input is already pending. Otherwise, immediately after invoking the aborting public API, it queues one hidden `prepare`-then-`execute` steer for the same recorded boundary. That synchronous ordering places the boundary ahead of later input rather than waiting for the compaction callback. The resumed message carries the opaque compaction request ID. Its `message_start` records the admitted stage, while reload still requires the exact boundary artifact because Prime Agent persists the custom message only after `message_start`. Duplicate callbacks and reload search the branch using the full session/lifecycle/cycle/goal correlation and do not send a durable boundary again.

Too-short, already-compacted, cancelled, and failed requests retain projection as the safe fallback. Ralph records only a bounded categorical outcome and uses the already queued boundary. If retained steering is selected before that boundary, the durable compaction record reconstructs the clean execution injection around the steering turn and aborts the later duplicate trigger. Reload converts a pending or prematurely admitted request with no compaction entry into an interrupted fallback. If the compaction exists but its exact boundary does not, reload requests that boundary once. None of these recovery steps advances the logical cycle or appends the prior pass log again. A newer distinct goal continuation still goes through normal identity and lifecycle checks and gets its own compaction attempt.

## Terminal execution-log recovery

A blocked or completed pass now records its final assistant message and timestamp in the lifecycle state before it writes `.ralph/logs/EXECUTION_LOG.md`. The terminal closeout clears that intent only after the log append succeeds.

If the log append fails, reload or the next same-session workflow transition retries the durable intent before it changes lifecycle state or admits another phase prompt. If the log append succeeds but the following state append fails, recovery may attempt the same log entry again. The execution log's semantic entry identity includes the session, Ralph lifecycle, terminal action, phase, cycle, and final message, so a retry is idempotent without collapsing a later lifecycle that happens to reuse the same cycle number and text. An incomplete or textless terminal intent fails closed instead of being silently erased. This ordering preserves the completed pass across either failure without reopening execution, duplicating the lifecycle, or relying on transcript reconstruction.

## Remaining durability work

Later increments still need the full execution-boundary crash matrix around every marker/state/send append position, plus failure injection around driver stop, readiness, and the file transactions that are not already covered. Reset races must also be repeated across extension reload. Each increment must leave a failed operation either safely retryable or durably terminal and must preserve the session JSONL and REPL state.
