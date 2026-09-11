# Native transport acceptance

These checks prove that the packaged extension is admitted through real Prime Agent `0.9.3` transports. They are narrower than the unit and deterministic lifecycle suites.

## Committed checks

- **Setup discovery:** a fresh source initialization and a packed-package installation are each loaded by a spawned Prime Agent `0.9.3` RPC process with skills, prompt templates, themes, context files, and session persistence disabled. `get_commands` must expose exactly the five project-owned Ralph commands, acknowledge abort, and resolve the extension symlink into the expected source or packed package. The check neither controls the daemon nor asserts provider or canonical-skill behavior.
- **Public reset compaction:** a foreground spawned RPC process with inherited worker capabilities removed uses documented provider registration and a loopback scripted OpenAI-compatible endpoint. One `/reset` must correlate and durably order its marker, native compaction, hidden prepare, full provider transcript, and completed state; expose a successful matching public `compaction_end` before provider admission; remove stale sentinels from provider view; preserve them in the append-only JSONL; and retain the exact session and system prompt. It uses only read-only daemon status to compare default identity before and after, accepts absence at both observations, and claims only `reset-compaction`.
- **RPC:** an LF-delimited client starts a session, sends `abort`, observes acceptance, and exits cleanly.
- **ACP initialization:** a JSON-RPC client completes `initialize` and `session/new`, receives protocol and session data, and closes at EOF.
- **ACP prompt:** a JSON-RPC client completes `initialize`, `session/new`, and `session/prompt`; the configured provider turn returns `end_turn`.

Run them from the package root:

```sh
npm run accept:public-setup-discovery
npm run accept:public-reset
npm run accept:native-rpc
npm run accept:native-acp
PRIME_RALPH_ACCEPT_PROVIDER=<provider> \
PRIME_RALPH_ACCEPT_MODEL=<model> \
npm run accept:native-acp-prompt
```

The provider-backed check accepts an explicit provider/model pair and emits only bounded protocol diagnostics on timeout.

## Transport rules

- Use strict LF-delimited JSONL for RPC and ACP clients.
- Buffer input by complete lines. Do not assume one read equals one message.
- Use a fresh disposable session for each check.
- Keep native transport acceptance separate from package unit tests and deterministic lifecycle fixtures.

## Scope

The setup-discovery check is public black-box evidence for source `init-loader`, `init-command-catalog`, and `package-installed-loader` only. It does not exercise `/reset`, `/spec-it-out`, or `/plan`; their lifecycle behavior requires separate spawned-transport proof. The public reset check supplies that proof only for `reset-compaction`. `reset-busy`, `reset-lifecycle`, specification, and planning remain outside its scope. Existing mixed init/package and reset fixtures remain package or gray-box compatibility evidence.

These checks do not prove every provider, prompt, tool, or long-running deployment. The public reset fixture proves one selected durable sentinel sequence and actual provider request, not universal host message conversion or real-model behavior.
