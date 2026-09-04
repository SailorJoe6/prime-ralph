---
name: spec-it-out
description: Turn the current conversation into a protected Ralph specification through an interactive workflow.
prime-ralph-invocation-version: 1
---

Use the plugin-authored `<prime-ralph-invocation>` immediately before this skill as the authoritative invocation fact. Accept only `specification-new`, `specification-existing`, or `specification-reset-existing`. Do not inspect files or infer plugin or lifecycle state to choose a mode. If the metadata is missing or names another mode, stop and report that the invocation is invalid.

Use the current conversation to help the user define a specification. Do not implement the work, begin planning, or start execution.

The only active specification path is `.ralph/plans/SPECIFICATION.md`.

For `specification-new`:

- clarify unresolved product or behavior decisions with the user;
- write the agreed specification to the exact active path; and
- remain in the interactive specification phase after writing it.

For `specification-existing`, warn the user that an active specification already exists. Do not edit or overwrite it before the user chooses. Offer exactly these choices:

1. After explicit confirmation, create a future specification at `.ralph/plans/future/<descriptive-name>/SPECIFICATION.md`.
2. Discuss the active specification and update it in place only after explicit agreement.
3. Cancel without changing or creating a specification.

A future specification is not active until the user deliberately moves it to the exact active path.

For `specification-reset-existing`, the reset cleared the conversation that could have described future work. Warn that an active specification exists, then offer only discussion and an explicit update of the active specification, or cancellation. Do not offer future-specification creation and do not modify the active specification before explicit agreement.

Use Beads only to record specification work when project policy calls for it. Creating a specification does not itself start planning or execution, and unrelated issues must not drive the specification.
