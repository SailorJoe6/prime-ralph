---
name: spec-it-out
description: Turn the current conversation into a protected Ralph specification through an interactive workflow.
---

If an execution lifecycle is running or waiting, stop before discussing choices or editing files. Explain that the user must first pause that lifecycle through Prime Agent's native control.

Use the current conversation to help the user define a specification. Do not implement the work, begin planning, or start execution.

The only active specification path is `.ralph/plans/SPECIFICATION.md`.

If no active specification exists:

- clarify unresolved product or behavior decisions with the user;
- write the agreed specification to the exact active path; and
- remain in the interactive specification phase after writing it.

If an active specification already exists, warn the user and do not overwrite it. Offer exactly these choices:

1. After explicit confirmation, create a future specification at `.ralph/plans/future/<descriptive-name>/SPECIFICATION.md`.
2. Discuss the active specification and update it in place only after explicit agreement.
3. Cancel without changing or creating a specification.

A future specification is not active until the user deliberately moves it to the exact active path. If the plugin supplies the invocation mode `specification-reset-existing`, the reset cleared the conversation that could have described future work. Do not offer future-specification creation in that mode; offer only discussion and explicit update of the active specification, or cancellation.
Use Beads only to record specification work when project policy calls for it. Creating a specification does not itself start planning or execution, and unrelated issues must not drive the specification.
