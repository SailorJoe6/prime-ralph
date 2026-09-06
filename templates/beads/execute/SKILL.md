---
name: execute
description: Execute one evidence-backed task in the active Ralph lifecycle and signal the correct next lifecycle state.
prime-ralph-invocation-version: 1
---

Study the exact active specification and execution plan:

- `.ralph/plans/SPECIFICATION.md`
- `.ralph/plans/EXECUTION_PLAN.md`

Treat durable project state as authority. Audit existing implementation, documentation, tests, and version-control state before deciding what remains. Preserve unrelated work.

The `<prime-ralph-invocation>` metadata identifies the current Ralph lifecycle and cycle. Use the `ralph_lifecycle` tool with exactly those identifiers. Never guess or reuse identifiers from an older prompt.

## Cycle-sized work-unit gate

Before editing, define one small, safely publishable increment. Record all of the following in the plan or its durable task tracker:

1. one independently testable behavior, transition, or failure window;
2. the exact exit condition for this cycle;
3. the major affected surface groups and the evidence each one requires; and
4. an explicit “not included this cycle” list.

Split work that spans more than about three major surface groups unless a short written safety rationale shows that the combined unit is still bounded. Surface groups include runtime behavior, persisted schema, recovery, unit tests, native acceptance, documentation, and publication. When a complete feature is too large, prefer an inactive protocol or helper increment, a conservative fail-closed vertical slice, or another independently safe boundary.

Budget the cycle as follows:

- Target implementation plus focused proof that normally fits within roughly 25–35% of one context window.
- Reassess scope near 25% context use. If the selected increment is not nearing code-complete by roughly 35–40%, stop expanding it. Narrow to a safely completed publishable checkpoint, disable or roll back only this cycle's affected behavior as project policy permits, or record a durable handoff after making the worktree safe.
- Reserve the final 20% for regression, independent review, durable tracking, documentation, commit, backup, push, verification, and the one lifecycle decision.

A checkpoint or handoff must still satisfy one of the normal lifecycle decisions below. It does not authorize an invented transition, incomplete publication, destructive rollback, loss of unrelated work, or omission of required evidence.

Classify review findings as **safety-invalidating**, **required acceptance**, **adjacent hardening**, or **optional**. Fix safety-invalidating findings within the remaining budget or disable, roll back, or leave the affected behavior unpublished. Complete required acceptance in this cycle. Track adjacent hardening for a later cycle unless it blocks safe publication. Do not defer the minimum tests and documentation for active runtime behavior to a later proof-only cleanup cycle.

## Native execution driver

Prime Agent's native thread goal is the sole automatic driver. Ralph's lifecycle identity remains separately owned by the plugin.

- On `execution-start`, inspect `await goal.get()`. If no goal is active, call `await goal.create("Continue the active Ralph execution lifecycle. Follow each injected prepare and execute skill, and make exactly one Ralph lifecycle decision per execution pass.")`. The user's `/execute` invocation authorizes this driver. If an unrelated active or paused goal exists, do not replace it; use the lifecycle status control and explain the conflict.
- On `execution-resume`, inspect `await goal.get()`. A matching paused native goal must be resumed by the user through native control rather than replaced. If the prior driver is terminal or absent because Ralph safely paused after a provider/driver failure, this explicit `/execute` authorizes exactly one replacement goal with the same standard objective and the same Ralph lifecycle.
- On later execution rounds, do not create a second goal except for the explicit waiting-readiness or terminal-driver recovery cases above. The existing active goal drives ordinary continuation.
- A successful `ready` call is the semantic decision for that readiness turn. End the assistant turn immediately after it succeeds. Do not inspect, fix, delegate, complete the newly created goal, or attempt `wait` or another lifecycle decision in that turn. If readiness evidence already shows that more asynchronous work is needed, stay waiting and do not create the new goal or call `ready`. If new asynchronous work becomes apparent only after `ready`, leave it for the clean execution continuation.
- If a provider or control failure nevertheless leaves Ralph paused after the just-readied goal became terminal, an agent-owned recovery may inspect `ralph_lifecycle status`, create exactly one replacement goal with the standard objective, and call `recover-driver` with the unchanged lifecycle and cycle. This recovery action only rebinds the driver and resumes the same open cycle; it does not log or advance the cycle. The plugin accepts it only when durable history proves the exact ready decision, terminal prior driver, decision closeout, replacement goal, and identity-mismatch pause. End the recovery turn immediately after success. If recovery is rejected, complete the replacement goal and leave Ralph paused for explicit user `/execute`; do not retry with another goal.
- Native `/goal pause`, `/goal resume`, and `/goal clear`, user steering, queued follow-ups, and abort remain Prime Agent controls. Do not emulate them with files or a second continuation mechanism.

For this round, choose the single highest-value task that advances the active plan. Record the selection and progress in durable project state. Implement it completely, add or update documentation and tests, run the required evidence gates, and record the results. Do not infer correctness from intent, prose, unchecked output, or the absence of errors.

At the end of the round, make exactly one semantic lifecycle decision. The decision belongs to you under this skill. The plugin and driver must not infer it from response wording, errors, elapsed time, tool activity, issue counts, or checkboxes.

Once terminal closeout begins, treat the native-goal action and Ralph lifecycle decision as one ordered protocol. After `await goal.complete()` succeeds, the matching `ralph_lifecycle` call MUST be your next action. If a queued user, child, steering, or custom host message splits the Agent run at that tool boundary, first finish the already-started lifecycle decision in the resumed run before inspecting or acting on unrelated queued content. Do not repeat `goal.complete()`, invent a different decision, or treat the handoff itself as pass completion.

- **Continue:** The task is complete, no asynchronous work remains, the plan still has executable work, and no blocker requires user help. Keep the native goal active. Call `ralph_lifecycle` with action `continue` and the current lifecycle and cycle identifiers. Do not directly start another round. Native goal continuation and Ralph's durable compaction transaction admit exactly one later round after host-observable tracked work settles.
- **Wait:** The current task remains open because identified asynchronous work is outstanding. Record what is outstanding and the evidence that establishes readiness. First call `await goal.complete()` so the native driver cannot continue. Then call `ralph_lifecycle` with action `wait`, the current identifiers, a bounded reason, readiness evidence, and any agent-owned wakeup identifier. Arrange only the minimum explicit user or agent-owned wake check. A waiting check keeps the current context and is not a completed pass. If evidence is still absent, do not create a goal or call Ready. Once evidence is observed, create a new native goal with the same standard objective, then call `ralph_lifecycle` with action `ready` and the unchanged lifecycle, cycle, and wait identifiers. This resumes the same Ralph lifecycle, not a new one.
- **Blocked:** Block only for a concrete dependency requiring user help, using the project criteria. Otherwise make one bounded safe in-scope attempt first. Record the exact blocker and unblock condition. Stop/delete any agent-owned wakeup, call `await goal.complete()`, then call `ralph_lifecycle` with action `block`, the current identifiers, reason, unblock condition, and `wakeupsStopped: true`. The control transactionally moves the exact active pair without overwrite and stops continuation. A control failure is not blocked state. After success, tell the user what help is required.
- **Complete:** Audit every specification requirement and project closeout gate. Stop/delete any agent-owned wakeup and call `await goal.complete()`. Call `ralph_lifecycle` with action `complete`. Set `archive: true` and a safe archive name only when the active project plan explicitly requires archival; otherwise use `archive: false`. A transaction failure is not completion.

Call the lifecycle control only after the corresponding native-goal action succeeds. A missing or incompatible lifecycle tool makes `/execute` unsafe; report it rather than emulating it through raw state or file edits.

If `/reset` is requested while running, finish or safely stop the open operation and make the required lifecycle decision; Ralph consumes the reset at the next eligible boundary. Waiting reset does not clear the open step. Paused reset does not resume work.

Your final response must identify the task attempted, evidence obtained, durable state updated, transition-control result, and selected lifecycle decision.

Use Beads for plan-related task tracking. Inspect relevant ready and in-progress issues. If project policy requires an issue and none exists, create a plan-related issue before implementation; otherwise record why no issue is required. Claim the selected issue, record evidence and lifecycle state, close only fully completed issues, and preserve unrelated issues. A Beads count, status, or checkbox is never by itself proof of task or plan completion. Publish a Beads backup only when the project's documented workflow requires one; absence of such a workflow is not itself a blocker.
