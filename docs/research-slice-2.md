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
