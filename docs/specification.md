# Interactive specification workflow

Slice 3 adds interactive specification startup and `/spec-it-out` without exposing planning or execution.

## Command surface

The production Slice 5 extension registers:

- `/reset`
- `/spec-it-out`
- `/plan`
- `/execute`

It does not register `/execute` or blocked-phase commands. This document focuses on the Slice 3 specification behavior; planning is documented separately. Prime Agent's native `/clear` remains unchanged.

## Startup preparation

For `session_start` reasons other than `reload`, the extension inspects the exact active specification path. If no active specification exists and the current session has no durable startup boundary, it validates and delivers `.ralph/skills/prepare/SKILL.md` as the first provider turn.

The hidden `prime_ralph_startup_prepare` message records the current Prime Agent session ID. This gives two distinct guarantees:

- rebuilding extensions through `/reload` never replays startup preparation; and
- a fork that inherits its parent's branch is not suppressed by the parent's marker.

Creating an active specification during the current specification phase does not start planning. A new session that already has an active specification selects the Slice 4 planning startup described in [`planning.md`](planning.md). A path conflict or invalid/missing prepare skill sends no startup prompt and produces a bounded diagnostic.

## Exact active-specification state

The only active path is `.ralph/plans/SPECIFICATION.md`. Code uses `lstat` on `.ralph`, `.ralph/plans`, and the destination, which detects a symlink without following its target. Missing components mean the specification is absent. Both parents must be real directories, and only a real regular destination file is classified as existing. Symlinks and other conflicting path types are rejected without traversal using distinct path-specific errors that tell the operator to replace the entry with the required real directory or regular file, or remove it, then retry.

This check is a conflict-safety invariant, not a filesystem security sandbox. The ordinary tool-using agent remains responsible for following the delivered skill when it later writes a user-approved document.

## Trusted invocation facts

`/spec-it-out` waits for the current agent operation, rechecks the exact path, validates the project prompt, and sends one follow-up without compacting or projecting the conversation. Canonical Ralph prompts remain under `.ralph/skills/` and are intentionally absent from `.agents/skills/`; direct skill invocation would omit the envelope and bypass this contract. The model-visible message contains a bounded JSON envelope immediately before the prompt:

```xml
<prime-ralph-invocation>{"protocolVersion":1,"specificationState":"absent","invocationMode":"specification-new"}</prime-ralph-invocation>
```

The closed modes are:

| Mode | Code-owned fact | Skill-owned behavior |
| --- | --- | --- |
| `specification-new` | Active specification is absent | Clarify and write the agreed active specification |
| `specification-existing` | Active specification is a regular file | Warn, then offer future/update/cancel without pre-consent mutation |
| `specification-reset-existing` | Active specification exists after a reset | Offer discuss/update or cancel; do not offer future creation because source conversation was cleared |

The envelope contains state only. It does not contain task criteria, a user choice, lifecycle claims, or path text copied from the project. The same facts appear in custom-message details for audit, but model behavior does not rely on those details being provider-visible.

The project skill must declare `prime-ralph-invocation-version: 1`. Package updates never rewrite project-local skills, so a project initialized with an earlier prompt receives an actionable compatibility error instead of silently using a prompt that guesses state. Merge the current canonical invocation contract into the project skill deliberately; rerunning `prime-ralph init` will continue to preserve it.

## Specification-aware reset

`/reset` rechecks state after Prime Agent becomes idle and validates every required skill before appending a reset marker or compacting.

- With no active specification, the reset boundary contains only `prepare`.
- With an active specification, the one atomic boundary contains `prepare` first, followed by `spec-it-out` in `specification-reset-existing` mode.
- With a conflict or incompatible skill, no marker, compaction, or prompt is produced.

The existing reset projection and recovery protocol remains authoritative. Creating a specification during the session does not start planning. The user must invoke `/plan`; specification-phase `/reset` remains in the existing-specification discussion behavior.

## Evidence layers

These evidence types are intentionally separate:

1. `npm test` verifies state classification, closed metadata, strict prompt compatibility, command registration, startup session identity, reload suppression, conflict handling, ordered reset injection, and legacy reset behavior.
2. `npm run accept:specification` uses a deterministic provider and real Prime Agent `0.9.1` session lifecycle. It proves startup is the first provider turn, reload does not replay it, `/spec-it-out` preserves conversation, reset excludes stale conversation, and no later workflow state starts. Initialization acceptance separately queries Prime Agent's real command catalog and rejects direct `skill:<canonical-name>` duplicates.
3. `npm run accept:model:spec-it-out` is an explicit real-model behavioral check. It uses a one-purpose exclusive-create tool instead of general shell or IPython access. It records sanitized provider/model, fixture, prompt hash, response, tool/file outcomes, assertions, and verdict. It never runs in the normal test suite.

The committed artifact at [`acceptance/spec-it-out-model-acceptance.json`](acceptance/spec-it-out-model-acceptance.json) covers default and Beads templates for new creation, initial existing-spec choices, explicitly confirmed future creation, explicitly agreed active update, cancellation, and reset-existing behavior. Static phrase assertions are structural evidence only and are not reported as proof of model behavior.

Run the real-model matrix explicitly:

```sh
PRIME_RALPH_REAL_MODEL_ACCEPTANCE=1 \
PRIME_RALPH_ACCEPT_PROVIDER=<provider> \
PRIME_RALPH_ACCEPT_MODEL=<model> \
npm run accept:model:spec-it-out -- --variant all --case all
```

The harness accepts no API-key flag and does not persist raw stdout, stderr, environment data, response IDs, thinking blocks, or credentials. Missing opt-in exits as skipped, never passed.
