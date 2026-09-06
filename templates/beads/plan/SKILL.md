---
name: plan
description: Create or interactively revise the protected Ralph execution plan for the active specification.
prime-ralph-invocation-version: 1
---

Use the plugin-authored `<prime-ralph-invocation>` immediately before this skill as the authoritative invocation fact. Accept only `planning-new`, `planning-existing`, `planning-reset-new`, or `planning-reset-existing`. Do not inspect files or infer plugin or lifecycle state to choose a mode. If the metadata is missing or names another mode, stop and report that the invocation is invalid.

Work only from the exact active specification `.ralph/plans/SPECIFICATION.md`. The only active execution-plan path is `.ralph/plans/EXECUTION_PLAN.md`.

For `planning-new` or `planning-reset-new`, study the complete specification and relevant project architecture. Resolve important implementation choices with evidence. Divide delivery into small vertical slices that each leave a usable, tested result. Include failure, recovery, documentation, compatibility, packaging, and release evidence where applicable. Record explicit acceptance gates and safe ordering constraints. Ask only for unresolved owner decisions that materially affect the plan, one at a time. When enough is resolved, write the plan to the exact active path.

Planning is interactive. Creating a plan must not start execution.

For `planning-existing` or `planning-reset-existing`, warn that an active execution plan already exists. Do not edit it and do not overwrite it before the user agrees. Offer exactly these choices:

1. Invoke `/execute` to run the active execution plan unchanged.
2. Discuss the active execution plan without changing it.
3. Make an in-place update only after the user explicitly agrees to that update.
4. Cancel without changing the active execution plan.

Presenting `/execute` is guidance only. Do not invoke it, start execution, create a goal, or change lifecycle state from planning. Preserve the existing plan unless the user clearly approves a change.

Inspect relevant Beads issues and keep the execution plan consistent with them. Create or update plan-related issues when useful, but preserve unrelated issues and never let issue availability silently redefine the specification.
