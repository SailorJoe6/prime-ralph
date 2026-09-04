---
name: execute
description: Execute one evidence-backed task in the active Ralph lifecycle and signal the correct next lifecycle state.
---

Study the exact active specification and execution plan:

- `.ralph/plans/SPECIFICATION.md`
- `.ralph/plans/EXECUTION_PLAN.md`

Treat durable project state as authority. Audit existing implementation, documentation, tests, and version-control state before deciding what remains. Preserve unrelated work.

For this round, choose the single highest-value task that advances the active plan. Record the selection and progress in the project's durable execution state or plan as appropriate. Implement it completely, add or update documentation and tests, run the required evidence gates, and record the results. Do not infer correctness from intent, prose, unchecked output, or the absence of errors.

At the end of the round, make exactly one semantic lifecycle decision. The decision belongs to you under this skill. The plugin and driver must not infer it from response wording, errors, elapsed time, tool activity, issue counts, or checkboxes.

- **Continue:** The task is complete, no asynchronous work remains, the plan still has executable work, and no blocker requires user help. Record progress and signal continuation through the agent-visible Ralph lifecycle control advertised for that purpose. Do not directly start another round or create another lifecycle. The plugin may admit exactly one later round only after its eligible boundary and clean `prepare` then `execute` sequence.
- **Wait:** The current task remains open because identified asynchronous work is outstanding. Record what is outstanding and the evidence that will establish readiness. Call the agent-visible Ralph lifecycle control advertised for entering `waiting`, following its schema exactly. No next round may occur merely because the turn ended, and no context reset, reminder loop, or second lifecycle is allowed. Call the matching readiness control only after the recorded evidence is actually observed; it must resume the same lifecycle.
- **Blocked:** Block immediately when no safe authorized action can resolve missing authority, unavailable credentials, required physical interaction, unavailable hardware, external coordination, contradictory authority, or another concrete dependency. Otherwise make one bounded safe in-scope attempt before blocking. A failed test, tool error, elapsed time, inactivity, or response wording is not enough by itself. Record the exact blocker and unblock condition, then call the agent-visible transactional Ralph block control. That control must validate and move the exact active specification and plan together to their exact `.ralph/plans/blocked/` paths and stop continuation and associated wakeups. Do not move them separately. A partial move, stale blocked content, or control failure does not establish blocked state; report the failure without claiming the transition. After success, tell the user work is blocked and request the specific help required.
- **Complete:** Audit every specification requirement and required project-defined closeout gate. Ensure implementation, durable documentation, tests, and any required publication are complete. Call the agent-visible transactional Ralph completion control, following its schema exactly, to archive the active specification and plan together under the skill policy and stop the execution driver. Do not move them separately or overwrite archive conflicts. A partial archive or control failure is not completion. Do not declare completion from plan checkboxes alone.

The Ralph execution command must remain unavailable unless the agent-visible controls required by this skill are present. Use the controls by their advertised lifecycle purpose and schema; do not emulate a missing control with raw state edits. This keeps project skills compatible if a later package version changes an internal tool name while preserving its declared transition contract.

User steering, pause, resume, and cancellation remain under Prime Agent's native controls. A paused lifecycle may resume only as that same lifecycle. If the user wants to discuss or change the plan or specification while execution is running or waiting, direct the user to pause first.

Your final response must identify the task attempted, evidence obtained, durable state updated, transition-control result, and selected lifecycle decision.
