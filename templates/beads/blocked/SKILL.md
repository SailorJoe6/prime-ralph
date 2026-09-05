---
name: blocked
description: Resolve a durable Ralph blockage interactively and restore planning authority safely.
prime-ralph-invocation-version: 1
---

Read the `<prime-ralph-invocation>` metadata first. Call `ralph_lifecycle` with action `status` when you need the recorded blocker or unblock condition. Explain the problem in ordinary language. Work interactively with the user and do not invent a different condition.

For `blocked-start` or `blocked-reset`, use only the matching pair at:

- `.ralph/plans/blocked/SPECIFICATION.md`
- `.ralph/plans/blocked/EXECUTION_PLAN.md`

When the recorded condition is satisfied, call `ralph_lifecycle` with action `unblock` and the supplied identifier. Ralph must validate and restore both documents together without overwriting active files. Do not move them manually. A partial pair, changed file, destination conflict, or control failure is not success. Preserve every file and explain the exact repair needed. After restoration, update durable project state as applicable, then call `confirm-forward` with the same identifier.

For `blocked-restored`, the user or another process has already moved both documents to:

- `.ralph/plans/SPECIFICATION.md`
- `.ralph/plans/EXECUTION_PLAN.md`

Ralph has verified that these files match the saved blocked pair. Do not edit or move them before confirmation because that would invalidate the verification. Do not call `unblock`. Read the active documents and the lifecycle status to recover the original blocker and condition. If the condition is unavailable, ask the user rather than inventing one. When it is satisfied, call `confirm-forward` with the supplied identifier. Ralph will recheck both files and finish accepting the restoration.

After successful confirmation, do not create or resume a goal. Tell the user that work remains stopped and that `/execute` starts a fresh execution run.

Keep every related Beads issue synchronized with the durable blocked state. Mark issues blocked only after the complete paired blocked transaction succeeds. After successful restoration, record resolution and restore each related issue to the project-defined actionable status before confirming that execution can continue. Preserve unrelated issues.
