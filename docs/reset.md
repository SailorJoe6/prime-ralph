# `/reset` context boundary

## Contract

`/reset` is a project-local Prime Agent command. It resets only model-visible messages in the existing session. It does not call `newSession`, session switching, forking, tree navigation, goal, autonomous, or REPL lifecycle APIs. It uses Prime Agent's public custom-compaction API when the host considers the current branch eligible.

The sole injected instruction is the exact content of `.ralph/skills/prepare/SKILL.md`, wrapped in a standard skill block carrying its resolved location. The skill is fully loaded and validated before the extension appends a marker or changes model-visible context.

Prime Agent's `/clear` command is not overridden. Prime Agent `0.9.1` handles `/clear` as a built-in alias for `/new` before extension command dispatch.

## Compaction and exact context

After Prime Agent admits the command, the extension:

1. appends a versioned non-model-visible `prime_ralph_reset_marker` with an opaque request ID;
2. obtains that marker's real entry ID from the current branch;
3. starts one fire-and-forget `ctx.compact()` operation and returns from the command handler;
4. matches only its request in `session_before_compact` and supplies an empty summary, the real marker ID as `firstKeptEntryId`, host `tokensBefore`, and bounded details;
5. verifies the completed result, then delivers one hidden `prime_ralph_reset_prepare` follow-up; and
6. completes only after that matching prepare message starts and its agent run ends.

The extension never awaits compaction from the command handler. Doing so prevents Prime Agent from reaching the idle boundary needed by manual compaction.

Prime Agent reconstructs an empty compaction as a fixed summary wrapper. The `context` hook removes only a versioned Ralph empty wrapper. Prime Agent invokes that hook before it appends the current custom prompt to the provider context, so the first reset transformation projects one in-memory copy of the exact pending prepare message and consumes that one-shot guard. The durable message is still written once to JSONL. Later transformations project from the newest persisted prepare message. That persisted-boundary projection is required as an exactness guard because Prime Agent can restore completed host-managed IPython turn structures around a compaction. It also keeps later tool continuations while excluding every message before prepare.

When Prime Agent rejects manual compaction with `Session is too short to compact` or `Already compacted`, the extension sends the same prepare boundary in `projection-fallback` mode. Other compaction failures send no prepare and produce a sanitized terminal failure.

## Queueing, cancellation, and recovery

A `/reset` still waiting in Prime Agent's input queue follows normal host semantics. Escape/Ctrl+C currently aborts active work while preserving queued input, so the plugin does not remove a queued reset specially. No plugin reset state exists until the command handler begins. Once it begins, reset wins the race.

Only one reset may be active. Duplicate handlers are coalesced while compaction or prepare delivery is pending. Compaction cancellation writes no compaction and sends no prepare; a later `/reset` can retry. An assistant `error` or `aborted` result after prepare is recorded as a sanitized failed state with the durable boundary preserved, without automatic replay.

On reload or restart, a persisted matching prepare boundary is recovered without replay. A compaction that completed before prepare admission is reported explicitly and can be retried. Session ID, session file, prior JSONL entries, and Prime Agent-managed serializable REPL state remain intact.

## Evidence

`npm test` covers strict YAML/UTF-8/size validation, real marker matching, custom compaction results, wrapper filtering, exact prepare projection, short fallback, duplicate handling, ordinary-compaction isolation, synchronous admission failure, provider error state, reload recovery, and shutdown interruption.

`npm run accept:reset` uses Prime Agent `0.9.1`, deterministic provider capture, a disk-backed session, and a real IPython kernel. It proves custom compaction plus short fallback, prepare-only initial contexts, two boundaries, stale user/assistant/tool exclusion, and stable system prompt/session/JSONL/REPL state.

`npm run accept:reset-busy` holds a provider turn open, queues ordinary input, queues `/reset` twice, and proves one reset occurs after earlier actions.

`npm run accept:reset-lifecycle` reopens a custom-compacted JSONL in a fresh runtime and tests compaction cancellation, zero partial prepare, retry, injected provider error, and another successful reset.

## Public-API boundary

Prime Agent `0.9.1` does not expose its stronger descendant-RLM quiescence barrier through `ExtensionCommandContext`. Slice 1 claims parent-session, active-tool, compaction, and normal input-queue ordering only to the extent covered by supported APIs. Arbitrary detached work is outside automatic detection. Later execution slices use the explicit Ralph waiting lifecycle rather than modifying Prime Agent.
