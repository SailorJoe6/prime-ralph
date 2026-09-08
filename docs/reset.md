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

Prime Agent `0.9.3` can refuse before `session_before_compact`:

- `Already compacted` means the branch's latest durable entry is already a compaction.
- `Session is too short to compact` means newer branch content exists but Prime Agent does not consider it sufficient for another summary boundary.

Neither refusal is a successful reset. The extension preserves the complete conversation and sends no prepare or phase prompt. For the short-session case it reports exactly:

> No reset was performed because the session is too short to warrant compaction.

The already-compacted case likewise states that no reset was performed. There is no projection fallback. Cancellation, unexpected results, append failure, interruption, and ambiguous recovery also admit no reset prompt.

## Queueing and recovery

A `/reset` still in Prime Agent's input queue follows normal host semantics. No plugin transaction exists until the command handler starts. If the handler starts while provider work or previously queued messages remain, it records one in-memory waiting request and starts the transaction from the first later `agent_end` with no pending messages. Duplicate waiting requests are coalesced. Shutdown clears a waiting request before any marker exists. Only one durable reset transaction may be active.

Reload validates durable evidence but never resends uncertain work. A boundary is usable only when the same request has a durable terminal `completed` state produced after a normal current-turn `turn_end`. An `agent_end` with no new normal assistant closeout is a failure even when older transcript history ends with a normal assistant. The one live exception is a host-proven queued-message handoff after a current non-error tool-use response with a real tool call: Ralph keeps the exact `context_admitted` request and workflow turn open for the next Agent run, and still requires a later normal closeout. The exemption is unavailable after reload and never classifies tool use itself as completion. A hidden boundary whose callback failed, whose provider turn failed, or whose admission was interrupted remains provider-denied after reload until an explicit retry compacts it away or `/ralph-recover` validates and removes that exact poisoned branch from active provider context. A compaction with no hidden boundary is reported without inventing one. Session ID, JSONL history, and Prime Agent-managed serializable REPL state remain intact.

## Provider-free emergency recovery

`/ralph-recover` is available even when the normal `context` hook denies every provider request. It accepts no arguments and does not call a provider, compact, summarize, fork, replace the session, create or alter a goal, make a lifecycle decision, or start a prompt or driver. It validates one exact failed or interrupted reset transaction with one marker, empty reset compaction, hidden control message, correlated state chain, and matching session/phase/lifecycle identities. New boundaries use reset evidence protocol v3. Historical v2 execution roots remain valid only through their complete exact bundle, which permits a long-running lifecycle to cross a reset protocol upgrade. Missing, duplicate, malformed, completed, stale, or mismatched evidence fails closed.

When the poison remains provider-visible, execution recovery traces the lifecycle to its unique initial `execute` boundary and targets that marker's parent. Other phases target the poisoned marker's parent. User-message and `custom_message` parents are rejected because Prime Agent navigation gives them edit semantics. This mode calls only `navigateTree(anchorId, { summarize: false })`, verifies the exact resulting leaf and unchanged session identity, and preserves the abandoned branch.

A second, narrower mode applies only when the latest compaction after the failed poison has an exact `firstKeptEntryId` strictly after a failed `execute-round` poison's hidden message, proving that the message is provider-invisible. The latest durable execution state must still name that exact request, session, lifecycle, cycle, and driver through its admitted continuation. It must retain `resetRequested: true`, have no pending decision, round, wait, or prior recovery, and have either the paused execution shape or the stale planning/inactive reconciliation shape. The selected poison must follow the one initial execution root, have no competing terminal request for that lifecycle/cycle, and the matching driver goal must no longer be active, paused, or budget-limited. An unrelated current goal is preserved. This mode does not navigate: it rechecks the exact current leaf and attaches provenance there, keeping later compacted summaries and conversation on the active branch.

Both modes append sanitized mode-bound provenance followed by one explicit clean `planning/inactive` workflow state containing a `recoveryRequired` record. The clean state has null lifecycle and driver, cycle zero, false reset request, and no pause, pending decision/round, wait, admitted continuation, or block. No success notice appears before both records are durable. The user must inspect the worktree, active planning documents, Git state, and issue state before a later explicit `/execute`; recovery never invokes `/execute` itself.

A crash after navigation but before either append is recovered by finding the one abandoned poison branch rooted at the current anchor. For either mode, a provenance-only reload appends only the missing inactive state. Completed recovery remains idempotent after reload and after later non-Ralph conversation or goal-accounting entries. Because Prime Agent `0.9.3` can advance in-memory entry state before an append error is known to be durable, an append error quarantines same-process recovery. Reload or restart the affected process before retrying.

If the extension cannot load, stop the affected process and run `prime-ralph recover --project <path>` to print the shell-safe offline inspection command. The helper changes and starts nothing. Its native fallback is a fresh `prime-agent --no-extensions --cwd <project>` process without `--continue`, `--resume`, or `--fork`.
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

`npm run accept:reset`, `accept:reset-busy`, and `accept:reset-lifecycle` exercise real Prime Agent `0.9.3` session behavior with deterministic provider capture. Execution and blocked-recovery acceptance cover automatic pass-boundary use of the same transaction.

## Public-API boundary

Prime Agent's public extension API exposes fire-and-forget `ctx.compact()` and a void `sendMessage()` without a delivery receipt. Prime Ralph therefore prefers fail-closed uncertainty over replay. It does not modify Prime Agent or infer completion of host-unobservable detached work.
