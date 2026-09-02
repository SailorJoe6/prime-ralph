# Slice 2 Research: Lifecycle Observability and Ralph Reference

## Scope

This report records the source study and the behavior-neutral observability capability delivered by Slice 2. It is intentionally not a production Ralph coordinator.

## Ralph reference study

The reference checkout at `~/.local/share/ralph` uses phase-specific skill files under `skills/default/<phase>/SKILL.md` and Beads variants under `skills/beads/<phase>/SKILL.md`. Its README and `docs/prompts-and-plans.md` establish these behaviors:

- planning state is represented by `.ralph/plans/SPECIFICATION.md` and `EXECUTION_PLAN.md`;
- repo skill files are copied/customized per project;
- phase selection is based on planning-document state;
- execute and handoff prompts are distinct;
- the existing Bash runtime owns phase dispatch.

prime-ralph retains the durable-plan and configurable-skill ideas, but the phase-dispatch responsibility is reserved for later plugin-native state/lifecycle work.

## Prime Agent source observations

The installed Prime Agent version is `0.8.0`. The extension types expose lifecycle hooks for session start, compaction, turns, messages, agent start/end, and provider context. The compaction API exposes `session_before_compact` and accepts a replacement `CompactionResult`. The context hook can replace provider-visible messages.

The underlying agent loop (installed `@earendil-works/pi-agent-core`) performs this order after an assistant response:

1. emits `turn_end`;
2. evaluates `shouldStopAfterTurn`;
3. polls steering/follow-up messages;
4. calls `getContinuationMessages`;
5. starts another turn when continuation messages exist;
6. otherwise emits `agent_end`.

Prime Agent installs goal continuation through `getContinuationMessages`. Goal context messages are technically `role: "custom"`, with `customType: "goal_context"`; the provider conversion maps ordinary custom messages to user messages. Goal state is persisted in `thread_goal_state` custom entries.

The source also shows that `turn_end` is emitted for tool-call turns, not only final natural-language responses. Requested compaction is queued and consumed at the boundary; threshold compaction has additional continuation bookkeeping. These observations must be tested in Slice 3 before production coordination is attempted.

## Delivered POC capability

`src/observability-extension.js` is opt-in and behavior-neutral. It records sanitized JSONL lifecycle records at `.prime-ralph/lifecycle.jsonl`. It excludes transcript/objective content and records only message shapes, custom types, tool-call presence, counts, compaction preparation facts, and safe goal-state fields.

`src/observability.js` provides pure projections and fixture-friendly tracing for tests.

## Assumptions

### Passed

- Prime Agent exposes the required lifecycle event names in its installed extension API.
- A custom extension can inspect the current branch through `ctx.sessionManager.getBranch()`.
- Goal and compaction state are represented by inspectable custom entries/messages.
- A behavior-neutral lifecycle tracer can be implemented without changing agent control flow.

### Not yet proven

- A `turn_end` handler can safely request compaction before a goal continuation is generated.
- Requested compaction automatically resumes an active goal continuation.
- A valid minimal `firstKeptEntryId` can produce the desired summary-only model context.
- Context-hook filtering preserves valid tool-call/result message structure.

These unresolved assumptions are explicit inputs to Slice 3 and Slice 4.

## Slice 3 initial source/runtime POC

The executable `scripts/run-agent-loop-poc.mjs` uses the installed `@earendil-works/pi-agent-core` with a deterministic stream function. Its trace confirms `turn_end` is emitted for a normal assistant response, then the continuation hook is consulted before the next turn boundary. The trace also demonstrates that the public core loop has no goal-specific continuation event.

`src/cycle-boundary-poc.js` encodes the research predicate: only a final normal assistant turn with no tool calls/results and an active goal is eligible for a cycle-compaction request. It remains research-only until requested-compaction ordering and resume behavior are tested through the full Prime Agent session wrapper.

## Requested-compaction source analysis (Slice 3 checkpoint)

The executable `scripts/analyze-compaction-continuation.mjs` checks the installed Prime Agent 0.8.0 and pi-agent-core source contracts. All checks pass: `turn_end` precedes `shouldStopAfterTurn`; `shouldStopAfterTurn` precedes `getContinuationMessages`; requested compaction is consumed after the loop stops; and goal continuation queuing is present in the threshold-compaction path.

This resolves the source-level question: a plugin calling `ctx.compact()` at `turn_end` cannot assume the normal goal continuation will be generated afterward. The production design must explicitly preserve or recreate continuation. A full Prime Agent wrapper integration test remains required before this is treated as runtime proof.


Reproduce the source analysis with:

```sh
PRIME_AGENT_SOURCE_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run poc:compaction-order
```

The command emits PASS/FAIL checks and exits non-zero when the installed source no longer matches the analyzed ordering contract.


## Full AgentSession compaction POC

The executable `scripts/run-agent-session-compaction-poc.mjs` constructs a real Prime Agent `AgentSession` with an in-memory `SessionManager`, a deterministic fake model stream, an active goal, and an extension implementing `turn_end` plus `session_before_compact`. It uses tiny compaction retention settings so the fixture is eligible without a large prompt.

Run it with:

```sh
PRIME_AGENT_SOURCE_ROOT=/path/to/prime-agent \
PRIME_AGENT_CORE_ROOT=/path/to/prime-agent/node_modules/@earendil-works/pi-agent-core \
npm run poc:session-compaction
```

Against installed Prime Agent 0.8.0, the POC passed with `compactionApplied: true`, the custom summary `RALPH POC BOOTSTRAP`, and exactly one provider call. It also found `postCompactionGoalContext: false`: requested compaction completed, but the normal active-goal continuation was not generated afterward. This is direct runtime evidence that the production plugin must explicitly recreate or preserve the continuation after requested compaction.


## `firstKeptEntryId` POC

The executable `scripts/run-first-kept-poc.mjs` constructs independent in-memory Prime Agent session branches, appends a custom Ralph compaction entry, rebuilds context, and converts it to provider messages. Against Prime Agent 0.8.0 it demonstrates:

- pointing at the first user entry retains the old user/assistant messages;
- pointing at the last assistant retains that assistant plus later goal context;
- pointing at a non-model-visible custom marker retains only the compaction summary plus the later `goal_context` message;
- pointing at the existing goal-context entry has the same effective result;
- an unknown ID currently produces summary-only context in `buildSessionContext`, but this is an undocumented fallback and is not selected as the production strategy.

The marker result is the safest useful boundary for a Ralph cycle: it is a real entry, does not add model-visible content, and preserves the goal context that follows it. The POC does not yet prove the production context-hook filter; that remains in the next compaction slice.


## Context-hook projection checkpoint

`src/ralph-context.js` provides a research-only pure projection for the `context` hook. When a compaction summary exists, it keeps the latest summary and subsequent `goal_context` messages while removing retained stale assistant history. Without a compaction summary it is a no-op. This proves the message-shaping policy in fixtures; wiring it into production lifecycle state remains a later coordinator task.


## Context-hook wiring checkpoint

`src/ralph-context-extension.js` is an opt-in wiring POC. It activates only when an extension-originated compaction summary begins with `RALPH_BOOTSTRAP:` and then returns the projected message list from the public `context` hook. Provider snapshots confirm the resulting sequence is the stable compaction summary followed by the `goal_context`, with stale retained assistant history removed. It is not enabled by the default no-op entry point.


## Cycle coordinator checkpoint

`src/cycle-coordinator.js` adds a tested, standalone state-machine seam for Slice 5. It persists sanitized cycle-state markers, rejects mismatched or duplicate compaction boundaries, and explicitly emits a `goal_context` continuation marker after a successful requested compaction when the goal remains active. Failure and restart behavior are covered. This is not yet wired to the live AgentSession event stream; integration and cancellation/restart fixtures remain.


## Continuation trigger integration finding

The full AgentSession fixture confirms the requested-compaction path ends after `session_compact` and does not produce a second provider call. An attempted direct `pi.sendMessage(..., { triggerTurn: true })` from the compaction callback is not accepted as the coordinator strategy: awaiting it deadlocks against the active compaction, while deferring it can re-enter the turn loop without a bounded cycle guard. The coordinator therefore keeps continuation admission as an explicit, separately guarded lifecycle action rather than hiding it in the compaction callback. Any future AgentSession adapter must schedule it only after compaction has fully settled and enforce a one-boundary/one-continuation invariant.


## Settled continuation adapter

`src/continuation-adapter.js` implements the safe seam identified by the live POC: compaction completion calls `settle()`, which defers admission until the compaction callback has returned. It admits at most one `goal_context` follow-up, honors inactive-goal and cancellation decisions, and reports provider admission failures without retrying implicitly. The adapter is host-independent and ready for AgentSession integration.


## Full explicit continuation POC

`scripts/run-agent-session-continuation-poc.mjs` is a real AgentSession fixture with automatic goals disabled to isolate plugin admission. Its `session_compact` handler schedules `pi.sendMessage` after the callback returns. Against Prime Agent 0.8.0 it produced exactly two provider calls, a persisted `custom_message` with `customType: goal_context` after the compaction entry, and a second `turn_end`/`agent_end`. This validates the settled-event adapter strategy when automatic goal continuation is not concurrently active.


## Multi-cycle AgentSession checkpoint

`npm run poc:session-multi-cycle` runs two requested-compaction boundaries in one long-lived AgentSession with a deterministic provider. It produced two compaction entries and two provider calls; exactly one `goal_context` was admitted between them, and the second boundary stopped without another continuation. This demonstrates bounded cycle admission and no repeated compaction after the configured stop boundary. Automatic Prime Agent goals remain disabled in this fixture; coexistence policy is still unresolved.


## Recovery checkpoint

The coordinator now exposes `recover()`: an interrupted nonterminal cycle transitions to an explicit `error` marker, preserving the exact recovery reason; a new `begin()` then starts a new cycle ID. Terminal failures are idempotent. Tests cover restart during compaction and provider-failure recovery.


## AgentSession failure and cancellation checkpoint

Two disposable fixtures now cover post-compaction failures. `poc:session-provider-error` injects a provider exception on the explicit continuation request and still terminates with a single continuation admission. `poc:session-cancellation` calls `agent.abort()` as the second provider request is admitted and records a bounded second turn plus `agent_end`. Both use automatic goals disabled to isolate plugin behavior; error/cancel reason fields need richer host-version-specific diagnostics before production integration.


## Automatic-goal coexistence finding

`poc:session-goal-coexistence` enables Prime Agent automatic goals while also injecting the explicit plugin `goal_context`. The bounded fixture observed three provider calls and multiple `thread_goal_state` updates after one requested compaction, proving automatic continuation can continue independently of the plugin and defeat a plugin-only compaction guard. A watchdog aborts at call three to keep the POC finite. Production must either disable automatic goals for Ralph-managed sessions or establish a host-supported ownership handoff; silently running both is unsafe.


## Stale continuation checkpoint

The coordinator now requires the current cycle ID, compaction boundary ID, rehydrating state, and a pending continuation before accepting a continuation. Older-cycle, wrong-boundary, and duplicate admissions are rejected. Diagnostic snapshots expose only state, cycle ID, boundary, and queue flags; marker details remain sanitized and are not copied into snapshots.


## Slice 6 configuration checkpoint

`src/skill-config.js` adds deterministic skill discovery and phase selection. Skill precedence is explicit configured directories, `PRIME_RALPH_SKILL_DIR`, `.prime-ralph/skills`, then `.ralph/skills`; the first existing phase file wins. Oversized/unreadable files produce bounded diagnostics. `selectPhase()` uses durable spec/plan/goal state and cycle state, prioritizing blocked, handoff, design, plan, prepare, and execute.


## Slice 6 configuration validation checkpoint

Skill configuration now supports `.prime-ralph/config.json` loading with bounded invalid-configuration diagnostics and rejects non-list `skillDirs`. `phaseIdentity()` validates known phases and produces a stable phase/skill identity record suitable for cycle markers and diagnostics. Tests cover malformed configuration and unknown phases; explicit-directory precedence remains tested.


## Slice 6 fixture and persistence checkpoint

`src/phase-runtime.js` combines durable-state phase selection with discovered skills and emits a compact phase-selection marker containing only cycle ID, phase, and skill identity. Fixture tests use separate temporary repositories with different `.ralph`/`.prime-ralph` layouts and verify missing skills do not prevent phase selection.


## Slice 7 ownership checkpoint

`src/beads-coordination.js` adds an in-memory Beads coordination seam: priority selection, one active lease, stale lease reclamation, owner-only checkpoint/release/close, required durable evidence, and fail-closed quality-gate aggregation. Evidence and errors are sanitized. This is a coordination fixture, not a replacement for the `bd` CLI/database transaction layer; production integration must preserve that boundary.


## Slice 7 metadata checkpoint

`src/coordination-runtime.js` binds issue leases to session ID, cycle ID, and an explicit actor label without changing Beads assignee semantics. It also selects phase-specific quality gates and passes phase context to each gate. Lease expiry remains owned by the coordination layer, while real `bd` persistence/atomicity remains an integration task.


## Slice 7 `bd` adapter checkpoint

`src/bd-cli-adapter.js` defines the narrow real-CLI boundary: issue inspection, claim, checkpoint note, and close are invoked with argument arrays, bounded note lengths, and JSON parsing. Nonzero exits and invalid JSON fail closed with short errors. Tests use an injected runner, so no live issue state is mutated by the standalone suite.


## Slice 7 lifecycle checkpoint

`src/goal-lifecycle.js` adds goal status transitions for active, paused, complete, blocked, error, and budget-limit outcomes. Heartbeats renew only the owning issue lease; terminal transitions release it and stop heartbeat work. Status details are sanitized.


## Scheduled heartbeat checkpoint

`GoalLifecycle.startHeartbeat()` installs at most one injectable interval and records errors as a bounded lifecycle error. Terminal transitions stop the interval and release the lease; `stopHeartbeat()` is idempotent. Tests use fake timer functions and do not leave background timers running.


## Slice 8 cache checkpoint

`src/cache-analysis.js` provides deterministic stable-prefix serialization with recursively sorted object keys, byte-level longest-common-prefix measurement, and a report that separates prompt-prefix equality from provider cache-hit billing. Tests cover key-order stability and dynamic suffix changes.


## Slice 8 repeated-cycle checkpoint

`cycleSnapshots()` and its tests model repeated Ralph completions with one stable prefix and changing suffixes. Unchanged cycles preserve the exact prefix bytes; changing the Ralph prompt produces a different prefix and is reported as invalidated. This measures prompt structure only, not provider cache billing.
