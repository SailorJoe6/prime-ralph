---
name: blocked
description: Resolve a durable Ralph blockage interactively and restore planning authority safely.
---

Read only the matching current-lifecycle pair at these exact paths:

- `.ralph/plans/blocked/SPECIFICATION.md`
- `.ralph/plans/blocked/EXECUTION_PLAN.md`

Older, nested, partial, or unrelated blocked content is not the active blocked declaration. Explain the exact recorded blocker and unblock condition. Work interactively with the user; do not invent separate unblock criteria.

When the recorded unblock condition is satisfied, call the agent-visible transactional Ralph unblock control, following its advertised schema exactly. The control must validate the matching pair and restore both documents together to:

- `.ralph/plans/SPECIFICATION.md`
- `.ralph/plans/EXECUTION_PLAN.md`

Do not move them separately. Neither active destination may be overwritten. A partial restore, stale source pair, destination conflict, or control failure is not success; preserve all files, explain the failure, and remain blocked.

After a successful transaction, record resolution in the project's durable plan or issue state as applicable and confirm that forward execution can resume. Do not resume automatically. Tell the user to invoke `/execute` to start a fresh execution lifecycle.
