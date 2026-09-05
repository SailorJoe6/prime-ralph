# Interactive planning workflow

Slice 4 added the complete interactive planning path. Slice 5 adds automatic execution without changing the planning protections described here.

## Command and startup behavior

The production extension registers `/reset`, `/spec-it-out`, `/plan`, and `/execute`. Exact blocked planning documents take startup precedence and route interaction through the blocked workflow. If those documents were moved back manually, Ralph keeps that recovery in the blocked workflow while it verifies the active files and original unblock condition. `/plan` and `/execute` remain unavailable until that check succeeds. The user then starts a new execution run explicitly with `/execute`.

A normal top-level session with an exact active `.ralph/plans/SPECIFICATION.md` starts in planning. The extension validates `prepare`, the exact active-plan state, and the project `plan` skill before admitting one hidden message. That message contains `prepare` first and the plan invocation second. An absent active specification retains the specification startup behavior. RLM child sessions (`rlmDepth > 0`) skip this automatic planning turn so the explicit RLM spawn task runs first.

Prime Agent `0.9.1` does not expose a reliable conditional command-registration predicate. `/plan` is therefore registered consistently and uses the specified fallback when the active specification is absent: it reports the required path and makes no context or document change.

## Active plan and trusted invocation facts

Only `.ralph/plans/EXECUTION_PLAN.md` directly under the active plans directory counts as the execution plan. Code checks `.ralph`, `.ralph/plans`, and the exact destination with `lstat`, so a symlink is detected without following its target. Parents must be real directories and the destination, when present, must be a regular non-symlink file. A symlink or another conflicting path type produces a distinct error that names the path and tells the operator to replace it with the required real directory or regular file, or remove it, then retry. Plans under `future/`, `archive/`, `blocked/`, or other names do not activate the path.

The plan prompt must declare `prime-ralph-invocation-version: 1`. The extension supplies one of four closed modes:

| Mode | Code-owned fact | Skill-owned behavior |
| --- | --- | --- |
| `planning-new` | Active spec exists; active plan is absent | Study the project and create the agreed active plan |
| `planning-existing` | Active spec and plan exist | Warn, then discuss, explicitly update, or cancel |
| `planning-reset-new` | Planning reset; active plan is absent | Re-enter fresh interactive planning |
| `planning-reset-existing` | Planning reset; active plan exists | Re-enter protected plan discussion |

The metadata states only mechanical facts. The skill owns questions, architecture choices, vertical slices, document content, consent, and all file changes.

## Phase distinction

Document presence does not replace plugin-owned phase state. A session that starts without a specification remains in specification phase if a specification appears later. Its `/reset` uses `specification-reset-existing` until the user explicitly invokes `/plan`.

The `/plan` transition creates a clean context boundary when:

- the current phase is specification, whether or not a plan already exists; or
- planning is active but no active plan exists.

After planning is established, `/plan` with an existing plan is the deliberate current-context exception. It injects only the protected plan discussion prompt and keeps conversation since the latest valid boundary.

Planning phase is recorded in versioned, session-scoped custom-message details. Extension reload reconstructs it only from a matching session ID. A fork cannot inherit its parent's phase marker.

## Planning-aware reset

`/reset` and fresh `/plan` share the same single-flight, durable marker and custom-compaction transaction. Every required state and skill is validated before a marker is appended. A planning boundary contains one combined `prepare`-then-`plan` message. Host short-session refusal uses the established exact projection fallback. Failure before skill admission produces no partial planning prompt.

Neither path creates or edits planning documents, starts a goal, registers `/execute`, or begins automatic work.

## Evidence

- `npm test` covers exact path and type classification, prompt validation, bounded invocation metadata, session-scoped phase reconstruction, startup deduplication, missing-spec fallback, both `/plan` context branches, both planning reset modes, and failure-before-boundary behavior.
- `npm run accept:planning` uses a deterministic provider and real Prime Agent `0.9.1`. It proves ordered startup, clean explicit transition, specification/planning reset distinction, current-context existing-plan discussion, plan protection, stable session identity, and zero execution state.
- `npm run accept:model:plan` is an explicit real-model behavioral matrix for both default and Beads prompts. It tests new plan creation, existing-plan warning and choices, explicit update, cancellation, and both reset modes with narrow plan-only tools. Its sanitized artifact is `docs/acceptance/plan-model-acceptance.json`.
- Initialization acceptance inspects the native command catalog after a fresh host lifecycle and rejects direct `skill:plan` duplicates.
