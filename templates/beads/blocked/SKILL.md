---
name: blocked
description: Resolve a durable Ralph blockage interactively and restore planning authority safely.
prime-ralph-invocation-version: 1
---

Read only the matching current-lifecycle pair at these exact paths:

- `.ralph/plans/blocked/SPECIFICATION.md`
- `.ralph/plans/blocked/EXECUTION_PLAN.md`

The `<prime-ralph-invocation>` metadata supplies the current blocked provenance identifier. Older, nested, partial, unproven, or unrelated blocked content is not the active blocked declaration. Explain the recorded blocker and unblock condition. Work interactively with the user; do not invent separate unblock criteria.

When the recorded unblock condition is satisfied, call `ralph_lifecycle` with action `unblock` and the exact provenance identifier. The control must validate and restore both documents together to their exact active paths without overwrite. Do not move them manually. A partial restore, stale source pair, destination conflict, or control failure is not success; preserve all files, explain the failure, and remain blocked.

After a successful restore, update durable project state as applicable and confirm that forward execution can resume. Then call `ralph_lifecycle` with action `confirm-forward` and the same provenance identifier. Do not start a goal or resume automatically. Tell the user to invoke `/execute` to start a fresh lifecycle.

Keep every related Beads issue synchronized with the durable blocked state. Mark issues blocked only after the complete paired blocked transaction succeeds. After successful restoration, record resolution and restore each related issue to the project-defined actionable status before confirming forward execution. Preserve unrelated issues.
