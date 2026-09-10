# Safe execution lifecycle

`/execute` starts one automatic Ralph execution run. This guide first separates the different layers involved, then describes their transitions and recovery behavior.

## Mental model and ownership

```text
Prime Agent session
├── prime-ralph workflow phase
│   ├── specification
│   ├── planning
│   ├── execution
│   │   └── execution state: running, waiting, or paused
│   └── blocked
├── Prime Agent native goal (parallel continuation mechanism)
└── agent turn
    └── provider/tool loop
        ├── provider response requests a tool
        ├── tool result
        ├── another provider call
        └── first normal non-tool response ends the turn
```

Prime Agent owns the session, native goal, agent turns, tool loop, JSONL history, and REPL. `prime-ralph` owns the workflow phase, one execution-run identity, its current cycle number, and the context presented to the model at Ralph boundaries.

The code and documentation use these terms:

- **Execution run:** everything started by one user `/execute`, until completion, blocking, or cancellation. The durable implementation field is `lifecycleId`.
- **Cycle:** one durable logical work unit within that run. `continue` closes the current cycle and permits the next cycle. Waiting or pausing can make one cycle span more than one agent turn.
- **Agent turn:** one provider/tool loop. Tool-request responses continue the loop. The first normal response without a tool call ends that turn.
- **Provider call:** one request to the model. A single agent turn can contain several provider calls and tool results.
- **Native goal continuation:** a new automatic agent turn started by Prime Agent while its built-in goal remains active.

There is no separately persisted “execution pass” counter. In the usual path, one completed execution invocation closes one cycle. During waiting, pausing, or failure recovery, several turns can belong to the same cycle. Prefer the exact terms above when that distinction matters.

## Cycle-sized work units

One Ralph cycle is a small publishable evidence increment, not every change that belongs to one broad feature. Before editing, the execute skill requires the agent to record one independently testable behavior, transition, or failure window; its exact exit condition; its major affected surface groups and required evidence; and a clear “not included this cycle” list.

The sizing heuristic targets implementation and focused proof within roughly 25–35% of a context window. The agent reassesses near 25%. If the increment is not nearing code-complete by roughly 35–40%, it stops expanding. It then narrows to a safely completed publishable checkpoint, disables or rolls back only that cycle's affected behavior as project policy permits, or records a durable handoff after making the worktree safe. The final 20% stays reserved for regression, independent review, durable tracking, documentation, commit, backup, push, verification, and the lifecycle decision. A checkpoint or handoff still has to satisfy a normal lifecycle decision; it never permits an invented transition, incomplete publication, destructive rollback, loss of unrelated work, or omitted evidence.

Work across more than about three major surface groups is split unless a written safety rationale shows the combined unit remains bounded. A major surface can be runtime behavior, persisted schema, recovery, unit tests, native acceptance, documentation, or publication. Minimum tests and documentation stay with any active runtime increment; they are not deferred to a later proof-only cleanup cycle.

Review findings are classified before more work is admitted:

- **Safety-invalidating:** fix within the cycle budget or disable, roll back, or leave the behavior unpublished.
- **Required acceptance:** complete before the increment can be published.
- **Adjacent hardening:** track for a later cycle unless it blocks safe publication.
- **Optional:** defer unless it fits without risking closeout.

When the complete feature does not fit, select an inactive helper or protocol increment, a conservative fail-closed vertical slice, or another independently safe boundary.

## Workflow and execution states

```text
planning/inactive -- user /execute --> execution/running
execution/running -- wait ---------> execution/waiting
execution/waiting -- ready --------> execution/running   (same run and cycle)
execution/running -- /goal pause --> execution/paused
execution/paused  -- /goal resume -> execution/running   (same run)
execution/paused  -- exact recover-driver -> execution/running (same open cycle)
execution/*       -- block --------> blocked/inactive
execution/*       -- cancel -------> planning/inactive
execution/running -- complete -----> planning/inactive
blocked/inactive  -- verified restore and confirmation -> planning/inactive
planning/inactive -- later user /execute ----------------> new execution run
```

`waiting` is planned suspension for a stated external condition. The current native goal is completed so it cannot start another cycle. `ready` requires the current wait ID and a newly active native goal, but retains the same Ralph execution run and cycle. A successful `ready` is the only semantic decision in its readiness turn, so the agent ends that turn immediately and leaves all further work to the clean native-goal continuation.

If the just-readied goal nevertheless becomes terminal before that continuation and goal-identity reconciliation pauses Ralph, `recover-driver` provides one narrow recovery behavior. It may adopt the current active replacement goal only when the retained session branch proves the exact sequence: matching `ready`, terminal prior driver, ready-decision closeout, one replacement goal, and the resulting identity-mismatch pause. The action only rebinds the driver and resumes the same execution run and open cycle; it does not log or increment the cycle. A duplicate call is rejected without a second adoption. An incomplete sequence, a later unrelated goal, or a failed durable state append leaves Ralph paused and explicitly recoverable through `/execute`.

`paused` is a user pause or safety stop. Native `/goal pause`, `/goal resume`, and `/goal clear` pause, resume, and cancel the matching run. Goal replacement, stale continuation, missing lifecycle decisions, provider errors, and abnormal closeout also fail closed rather than silently continuing.

## `/execute` and the native goal

`/execute` accepts only the exact regular files:

```text
.ralph/plans/SPECIFICATION.md
.ralph/plans/EXECUTION_PLAN.md
```

It refuses blocked work, a duplicate run, and an unrelated active or paused native goal. The first injected `execute` skill creates Prime Agent's native goal through the public `goal` skill. That goal is the only automatic continuation mechanism and supplies Prime Agent's tracked-RLM waiting behavior. The extension does not run a competing continuation loop.

The extension records the goal ID assigned to the run. When Prime Agent later supplies a `goal_context` continuation, Ralph checks that:

1. its goal ID equals the run's recorded goal ID;
2. its continuation counter is a valid integer;
3. that exact `goalId:continuationsUsed` combination has not already been admitted;
4. the run and cycle are still current; and
5. the previous explicit lifecycle decision permits another execution invocation.

A mismatch pauses execution. Ralph never attaches unrelated goal work to the current run.

## Explicit lifecycle decisions

`ralph_lifecycle` is a sequential tool registered by the extension. The model must call it. Prose, `turn_end`, errors, elapsed time, and issue counts do not select transitions.

Native goal completion and the matching Ralph lifecycle call are an ordered closeout protocol. A supported Prime Agent queued steering or child-result handoff may end an Agent run immediately after a successful tool-use response. Ralph observes each `agent_start` as an in-memory run epoch and records the actual live `AbortSignal` during each synchronous successful `tool_result`. It preserves the exact `context_admitted` reset request only when every tool-call ID in the latest non-error `toolUse` batch has one exact non-error transcript result and one matching synchronous witness from that request and run, every witness shares the same still-unaborted signal, and public `ctx.hasPendingMessages()` currently proves queued work. A defined dynamic `ctx.signal` must be that same object; only an absent dynamic signal may use the retained object. The one delayed-origin exemption requires the exact admitted replacement boundary to be absent from that `agent_end`; once the exact boundary is visible, an abort or error is replacement-run evidence and fails closed even before the first tool witness. Reset and workflow handlers consume one cached verdict for the exact `agent_end` event before either can yield or mutate state. The model then finishes the already-started lifecycle decision before unrelated queued work, and a later normal text-only response settles the boundary. Tool use alone never counts as completion; partial results, duplicate IDs or callbacks, no-pending, stale run/request/event reuse, error, abort, reload, shutdown, and signal mismatch remain fail-closed. Witnesses and verdicts are never persisted or reconstructed.

- `continue`: keep the native goal active and request the next cycle.
- `wait`: record why the current cycle cannot proceed and the exact evidence that will establish readiness.
- `ready`: resume the same open cycle with the matching wait ID and a new native goal.
- `recover-driver`: rebind one exact post-ready terminal replacement driver without closing the open cycle.
- `block`: stop the native goal and move the exact planning pair into the blocked folder.
- `complete`: stop the native goal and finish the execution run. Archival is separate and explicit.
- `unblock`: restore a normally blocked pair together without overwrite.
- `confirm-forward`: state that the original blocker is resolved. For files restored manually, this also performs the final mechanical verification described below.

For `continue`, the current cycle is committed only when the matching next native continuation reaches the context hook after tracked RLM work settles. Ralph first logs the completed cycle and durably arms one pending round. It then appends the reset marker and requests one public `ctx.compact()`. The cycle number does not advance and no execute message is sent while compaction is pending. If tracked RLM delivery splits the pass across Agent runs, Ralph re-registers the reconciled running pass before the later run starts. Its closeout fence accepts either local event ordering and fails closed after a bounded wait rather than hanging admission.

## Native pass boundaries and transcript equivalence

Every new eligible execution cycle begins only after its matching reset-flavor compaction succeeds. The successful callback queues one model-visible message containing the project `prepare` skill followed by `execute`; the pre-provider `context` gate commits the new cycle only when that exact message matches its durable `prepare_pending` admission evidence. The specification and plan are not copied into the prompt. The skills tell the model to read durable project state.

Automatic execution does not use provider-context projection. Old conversation remains in the session JSONL, but the durable host compaction makes it unavailable to later provider requests. Later provider calls in the same cycle use the ordinary complete current-iteration context. Native goal pause/resume does not compact, re-inject skills, change the boundary, or transform context; feedback and acknowledgements added while paused remain visible.
After the latest visible native compaction boundary, every ordinary user, assistant, tool, steering, child-notice, and custom conversation message reaches the LLM unchanged and in the same order. Production context hooks validate or abort; they never rewrite a provider request that proceeds. Hidden Ralph skill messages are additive.

Short-session refusal, an already-compacted branch, cancellation, failure, interruption, rejected hidden-message delivery, or ambiguous recovery admits no next cycle and pauses safely. A prepared automatic boundary advances the cycle only after exact pre-provider context admission. A bounded delivery watchdog terminalizes a fire-and-forget request only when the host is idle, has no pending actions, and lacks its exact durable dispatch record; accepted queued work survives the deadline. Otherwise the next input or reload performs the same provider-free reconciliation after the rejected queue drains. All paths preserve the prior lifecycle, goal, and cycle identities. Prime Agent `0.9.3` checks short/already-compacted conditions before the extension compaction hook, so the public extension API cannot force those cases. Ralph deliberately does not restore automation with a projection fallback.

## Waiting and reset

Tracked RLM work is held by Prime Agent's native goal until descendants settle. Work Prime Agent cannot observe uses `wait` and `ready`, plus an agent-owned heartbeat or a later user response when needed. A waiting check is not a completed cycle and is not logged.

`/reset` behaves by state:

- running: request a fresh execution invocation at the next eligible boundary;
- waiting: keep the current cycle open and defer reset;
- paused: create a clean `prepare`-then-`execute` boundary without automatically resuming;
- blocked: create a clean `prepare`-then-`blocked` interaction.

See [`reset.md`](reset.md) for native compaction, refusal, and transcript-transparency details.

## Blocked files and recovery

A normal block transaction moves the exact specification and plan together into `.ralph/plans/blocked/`. It records their paths, byte lengths, SHA-256 hashes, and execution-run ID in `.ralph/plans/blocked/.prime-ralph-lifecycle.json`. No-replace moves, symlink checks, and rollback protect partial operations and destination conflicts. The current execution pass then gives its final user-facing help request. After that pass ends, Ralph performs one native compaction and durably queues hidden `prepare` then `blocked` without starting a redundant provider turn. The user's next response begins the blocked pass only after that boundary succeeds.

The normal unblock path is:

1. The model and user establish that the recorded blocker is resolved.
2. `unblock` verifies and restores both files together.
3. The model updates durable project state as required.
4. `confirm-forward` records the semantic confirmation.
5. Execution remains stopped until the user invokes `/execute`, which creates a new run.

### Files moved manually

A user or another process may move the exact blocked files back to their active paths before Ralph calls `unblock`. Ralph treats this as blocked work that needs verification, not as ordinary planning and not as automatic permission to execute.

When the saved hashes match the active files, Ralph supplies the blocked skill in `blocked-restored` mode. The model must:

1. call `ralph_lifecycle status`; its model-visible text includes the recorded blocker and the exact condition required before execution can restart;
2. read the active documents and recover that original blocker and condition without inventing a replacement;
3. avoid editing or moving the files while their saved hashes are being used;
4. determine with the user whether the condition is satisfied; and
5. call `confirm-forward` rather than `unblock`.

`confirm-forward` rechecks both active files, verifies the saved execution-run ID, records an adoption intent, and removes only the saved blocked-work marker. It then returns to planning/inactive. The intent makes a crash or durable-state write failure after marker removal recoverable: restart rechecks the active files against the intent before completing the state transition.

Modified, partial, unproven, stale, symlinked, or conflicting pairs remain blocked. Diagnostics name the observed condition and safe next action without requiring the user to understand internal state fields. `/execute`, `/plan`, and `/spec-it-out` remain unavailable while this check is outstanding. `/reset` restarts the clean recovery interaction.

Blocked recovery uses no provider-context projection. After its native compaction boundary, the hidden blocked control message, user responses, status tool call and result, confirmation tool call and result, and final assistant response reach the provider unchanged and in their original order. A blocked boundary is established only when its correlated reset state is durably `completed`. A failed or uncertain blocked-pass compaction, including failure after the hidden message was persisted, leaves the workflow durably blocked and provider-denies that stale message until an explicit retry compacts it away.

Completion does not force archive. When the project skill explicitly requests archival, both active documents move to one safe named directory under `.ralph/plans/archive/<name>/`.

## Poisoned-boundary recovery

A failed or interrupted reset boundary remains fail-closed. If fire-and-forget delivery was rejected before provider admission, the delivery watchdog records the exact reset failure and pauses the pending round without advancing its cycle. Ralph consumes no ordinary provider input while that failed driver is active and reports the provider-free operator path: `/goal clear`, inspect the durable failure, then use `/execute` to create a fresh lifecycle. Goal clear remains a native session command, and the next ordinary input reconciles the failed execution state to `planning/inactive` instead of entering a repeated context-abort loop.

When the poison remains provider-visible, `/ralph-recover` is the provider-free escape hatch. Execution recovery validates the poisoned request and the unique initial `execute` transaction for the same lifecycle, then navigates to the initial marker's targetable parent with `summarize: false`. That removes all Ralph execution and driver state from the active branch while keeping the abandoned branch and every existing JSONL byte.

If the latest compaction after the exact failed poison has an exact `firstKeptEntryId` strictly after an exact failed `execute-round` poison's hidden message, proving that the message is provider-invisible, recovery can instead keep the current active branch. This lossless path requires the latest stale workflow state to bind the same session, request, lifecycle, cycle, and retired driver, retain reset ownership with no pending semantic work, and prove the matching driver goal is no longer live. It preserves later compacted summaries, conversation, REPL state, worktree state, and an unrelated active goal. It rejects ambiguous history rather than selecting an old failure heuristically.

After exact leaf verification, Ralph appends mode-bound sanitized recovery provenance and a clean `planning/inactive` state with a structured `recoveryRequired` record. It starts no model, goal, driver, compaction, prompt, lifecycle decision, or automatic execution. A later explicit `/execute` clears `recoveryRequired` only when its new reset boundary is admitted durably. Append uncertainty quarantines the live runtime until extension reload or process restart; completed recovery is idempotent across reload and later ordinary entries. See [`reset.md`](reset.md) for the full candidate, crash/reload, and offline fallback rules.
## Execution log

Completed cycles append to:

```text
.ralph/logs/EXECUTION_LOG.md
```

The writer creates a missing real logs directory, rejects symlinks and incompatible paths, and never truncates the file. It writes one header for each contiguous session section and one entry containing UTC timestamp, phase, cycle, and final assistant response. Waiting checks and interactive specification, planning, or blocked turns are not logged.

## Evidence

`npm test` covers lifecycle transitions, goal correlation, repeated provider calls, waiting/readiness, reset branches, blocked and restored-file transactions, adoption failure recovery, stale signals, path conflicts, and logging.

`npm run accept:recovery` proves provider-free same-session tree recovery and lossless in-place post-compaction repair, append-only prefix and active/abandoned branch retention, compacted-summary, conversation, unrelated-goal, REPL, and worktree continuity, reload idempotence, and native navigation cancellation.

`npm run accept:execution` uses Prime Agent `0.9.3` with a deterministic provider. It proves three native-goal-driven cycles, tracked-RLM deferral, clean context, retained tool results, logging, and stable session, JSONL, and REPL identity.

`npm run accept:execution-goal-closeout` uses only public Prime Agent `0.9.3` session, goal/IPython, Faux-provider, extension, and `SessionManager` surfaces. It forces Wait/Ready, a retryable provider error, direct retry without `before_agent_start`, Continue closeout, and automatic next-cycle compaction. The unmodified baseline fails before cycle advancement. The corrected runtime commits the final assistant exactly once, advances once, enters Faux once with a fresh signal, and reaches a normal cycle-two terminal barrier before fixture teardown.

`npm run accept:execution-ready-handoff` reproduces the native Wait/Ready ordering where a newer child custom message follows a historical goal continuation. It proves the replacement driver binds without a false abort, the historical continuation cannot claim the newer turn, a current replacement continuation still runs, and the same lifecycle and cycle complete on Prime Agent `0.9.3`.

`npm run accept:blocked-recovery` physically leaves the saved marker in the blocked folder while moving the exact pair back to the active paths. It proves that the recorded blocker and unblock condition reach model-visible tool text, the recovery interaction stays clean through repeated tool results, marker adoption leaves the files unchanged, execution does not restart automatically, and only an explicit `/execute` creates a fresh run. Its direct context-transform connection is version-specific acceptance scaffolding; production code uses registered public extension hooks.

`npm run accept:model:blocked-recovery -- --variant all` is an opt-in controlled-model check. It verifies both prompt variants cause the model to inspect status and restored documents, confirm only after synthetic evidence satisfies the recorded condition, avoid a second unblock, and explain that `/execute` is still required.

Separate controlled-model acceptance proves the public `goal.create` and `goal.complete` path and semantic completion through `ralph_lifecycle`.
