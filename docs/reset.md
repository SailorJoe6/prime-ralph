# `/reset` context boundary

## Contract

`/reset` is a project-local Prime Agent command. A successful reset uses one native durable compaction inside the existing session and re-enters the current plugin-owned phase. It does not create, switch, fork, or replace a session. It does not clear Prime Agent's REPL state. Prime Agent's built-in `/clear` remains unchanged.

The extension validates every required project skill before recording a marker. The hidden post-compaction control message contains `prepare` first and the selected phase skill second when phase re-entry requires one.

## Native compaction transaction

After Prime Agent admits the command, the extension:

1. appends a versioned non-model-visible marker with an opaque request ID;
2. obtains that marker's real durable entry ID;
3. starts one public fire-and-forget `ctx.compact()` request;
4. matches only that request in `session_before_compact` and supplies an empty summary, the real marker as `firstKeptEntryId`, host `tokensBefore`, and bounded details;
5. verifies the completed result and durably queues one hidden canonical control message; and
6. validates exact durable message/state correlation at provider admission.

Prime Agent's natural post-compaction context is authoritative. The production `context` hook does not remove the host's empty-summary wrapper, select a newer boundary, or return a replacement list for a provider request that proceeds. It returns an empty list only together with `ctx.abort()` when exact admission evidence is missing or invalid.

After the latest visible native compaction boundary, every ordinary user, assistant, tool, steering, child-notice, and custom conversation message reaches the LLM unchanged and in the same order. Hidden Ralph control messages are additive. They never substitute for visible conversation.

## Refusal and failure

Prime Agent `0.9.1` can refuse before `session_before_compact`:

- `Already compacted` means the branch's latest durable entry is already a compaction.
- `Session is too short to compact` means newer branch content exists but Prime Agent does not consider it sufficient for another summary boundary.

Neither refusal is a successful reset. The extension preserves the complete conversation and sends no prepare or phase prompt. For the short-session case it reports exactly:

> No reset was performed because the session is too short to warrant compaction.

The already-compacted case likewise states that no reset was performed. There is no projection fallback. Cancellation, unexpected results, append failure, interruption, and ambiguous recovery also admit no reset prompt.

## Queueing and recovery

A `/reset` still in Prime Agent's input queue follows normal host semantics. No plugin transaction exists until the command handler starts. If the handler starts while provider work or previously queued messages remain, it records one in-memory waiting request and starts the transaction from the first later `agent_end` with no pending messages. Duplicate waiting requests are coalesced. Shutdown clears a waiting request before any marker exists. Only one durable reset transaction may be active.

Reload validates durable evidence but never resends uncertain work. A boundary is usable only when the same request has a durable terminal `completed` state produced after a normal current-turn `turn_end`. An `agent_end` with no new normal assistant closeout is a failure even when older transcript history ends with a normal assistant. A hidden boundary whose callback failed, whose provider turn failed, or whose admission was interrupted remains provider-denied after reload until an explicit retry compacts it away. A compaction with no hidden boundary is reported without inventing one. Session ID, JSONL history, and Prime Agent-managed serializable REPL state remain intact.

## Phase behavior

- Specification without an active spec: hidden `prepare` only.
- Specification with a newly active spec: hidden `prepare` then `spec-it-out` in reset-existing mode.
- Planning: hidden `prepare` then the correct `plan` mode.
- Paused execution: hidden `prepare` then `execute`, with no automatic work until native resume.
- Waiting execution: no reset until the open asynchronous work is resolved.
- Blocked workflow: hidden `prepare` then `blocked` after native compaction.

Execution-to-execution and execution-to-blocked automatic pass boundaries use the same native transaction and never use provider-context projection.

## Evidence

`npm test` covers marker correlation, custom results, honest refusal, exact admission, no successful context rewrite, duplicate handling, ordinary-compaction isolation, failure, reload, and interruption.

`npm run accept:reset`, `accept:reset-busy`, and `accept:reset-lifecycle` exercise real Prime Agent `0.9.1` session behavior with deterministic provider capture. Execution and blocked-recovery acceptance cover automatic pass-boundary use of the same transaction.

## Public-API boundary

Prime Agent's public extension API exposes fire-and-forget `ctx.compact()` and a void `sendMessage()` without a delivery receipt. Prime Ralph therefore prefers fail-closed uncertainty over replay. It does not modify Prime Agent or infer completion of host-unobservable detached work.
