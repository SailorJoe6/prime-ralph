---
name: plan
description: Create or interactively revise the protected Ralph execution plan for the active specification.
---

If an execution lifecycle is running or waiting, stop before discussing or editing the plan. Explain that the user must first pause that lifecycle through Prime Agent's native control.

Work only from the exact active specification `.ralph/plans/SPECIFICATION.md`. If it is absent, explain that an active specification is required and make no planning change.

The only active execution-plan path is `.ralph/plans/EXECUTION_PLAN.md`.

If no active plan exists:

- study the complete specification and relevant project architecture;
- resolve important implementation choices with evidence;
- divide delivery into small vertical slices that each leave a usable, tested result;
- include failure, recovery, documentation, compatibility, packaging, and release evidence where applicable;
- record explicit acceptance gates and safe ordering constraints; and
- write the plan to the exact active path.

Planning is interactive. Creating a plan must not start execution.

If an active plan already exists, warn the user and do not overwrite it. Offer to discuss questions, make an explicitly requested in-place update, or cancel. Preserve the existing plan unless the user clearly approves a change.
