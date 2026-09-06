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

## Post-ready terminal-driver recovery

The canonical execute skill ends a readiness turn immediately after `ready` succeeds. It does not complete that newly created goal or attempt a second lifecycle decision before `turn_end` clears the ready decision. This ordering prevents the ordinary agent path from stranding a terminal ready driver.

Provider or control failure can still produce the historical failure window. For that one case, the narrow `recover-driver` action can recover from the exact `native goal identity changed` pause without changing ordinary `continue` semantics. Recovery requires the latest three execution records to be the matching ready decision, its normal same-cycle closeout, and the identity-mismatch pause. The retained branch must also place the recorded driver's terminal goal state between ready and closeout, followed by exactly one latest active replacement goal before the pause. The action changes only the driver binding, running status, recovery-turn decision, and resume marker. It does not log or increment the cycle.

The replacement adoption and recovery decision are one durable state append. An append failure leaves the paused record authoritative and retryable. A successful append makes a duplicate call fail under the normal one-decision rule. Recovery-turn closeout clears that decision, and the matching native continuation then supplies one clean `execution-resume` boundary for the unchanged cycle. Missing history, changed ordering, a nonterminal old driver, or a newer unrelated goal cannot use the recovery and remains paused for explicit `/execute`.

## Durable pre-round compaction

A completed `continue` decision authorizes one pending next round. The lifecycle state records the exact goal continuation, next cycle, request ID, and `armed` stage before the reset marker is appended. Marker observation advances the transaction to `compacting`. No execute prompt or provider request for the next round is admitted at either stage.

The existing reset transaction supplies one empty custom compaction through public `ctx.compact()` and `session_before_compact`. Only its successful callback may journal `admission-requested` and queue the exact combined `prepare`-then-`execute` message. `message_start` validates ownership but does not advance the cycle because Prime Agent has not persisted the message yet. The pre-provider `context` gate must observe exactly one correlated boundary together with its durable `prepare_pending` evidence before it advances the cycle and records the admitted continuation. An automatic round is requested from a native-continuation provider context that Ralph intentionally aborts. The reset transaction ignores exactly the first originating `agent_end`, whether or not the host stored a new aborted assistant and whether or not the replacement hidden message was queued first. Any later `agent_end` belongs to the admitted replacement pass and must settle from its own positive normal `turn_end` or fail closed. Prime Agent persists the custom message asynchronously after the gate, so reload treats any still-pending transaction as uncertain and never resends it. This gives durable ordering `arm → marker → compaction → admission request → durable admission evidence → context admission`.

Automatic execution has no context-projection fallback. Short/already-compacted refusal, cancellation, failure, unexpected results, marker or state failure, and ambiguous or interrupted reload all admit no round and pause. The reset context handler is the sole admission owner. An unrelated queued context is aborted without changing a nonterminal reset transaction. Every provider-visible hidden reset boundary must correlate to either the current in-memory admitted turn or a durable terminal `completed` state. Failed, interrupted, missing, and legacy recovered states remain provider-denied until an explicit retry compacts the stale message away. Reload fails a still-pending `admission-requested` transaction even when its message is present because provider delivery is uncertain; it never promotes or resends that message. This chooses duplicate prevention over unprovable delivery across Prime Agent `0.9.1`'s void `sendMessage` API.

Native goal pause/resume stays within the admitted iteration. Prime Agent intentionally emits a duplicate same-identity `goal_context` on resume; Ralph treats it as driver plumbing, makes no state boundary, performs no compaction or projection, injects no skill, and preserves all current-iteration messages.

Historical `armed` and `projection-consumed` records remain readable so existing sessions fail closed rather than becoming corrupt. Production workflow code no longer exports or calls projection arm, consume, suppression, context-slicing, or standalone execution-compaction helpers. Research-only modules and package APIs are removed; the active producer reuses the reset transaction.

Blocked-pass admission uses the same native transaction after the execution pass gives its final help request. It durably queues hidden `prepare` then `blocked` without triggering a redundant turn. Provider input after that compaction boundary remains transcript-equivalent to the visible session; blocked recovery performs no slicing or reordering.

## Terminal execution-log recovery

A blocked or completed pass now records its final assistant message and timestamp in the lifecycle state before it writes `.ralph/logs/EXECUTION_LOG.md`. The terminal closeout clears that intent only after the log append succeeds.

If the log append fails, reload or the next same-session workflow transition retries the durable intent before it changes lifecycle state or admits another phase prompt. If the log append succeeds but the following state append fails, recovery may attempt the same log entry again. The execution log's semantic entry identity includes the session, Ralph lifecycle, terminal action, phase, cycle, and final message, so a retry is idempotent without collapsing a later lifecycle that happens to reuse the same cycle number and text. An incomplete or textless terminal intent fails closed instead of being silently erased. This ordering preserves the completed pass across either failure without reopening execution, duplicating the lifecycle, or relying on transcript reconstruction.

## Remaining durability work

Later increments still need failure injection around other state-append positions, driver stop, readiness, and the file transactions that are not already covered. Reset races must also be repeated across extension reload. Each increment must leave a failed operation either safely retryable or durably terminal and must preserve the session JSONL and REPL state.
