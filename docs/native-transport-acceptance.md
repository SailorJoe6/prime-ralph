# Native transport acceptance

These checks prove that the packaged extension is admitted through real Prime Agent `0.9.3` transports. They are narrower than the unit and deterministic lifecycle suites.

## Committed checks

- **Setup discovery:** a fresh source initialization and a packed-package installation are each loaded by a spawned Prime Agent `0.9.3` RPC process with non-extension resources disabled. `get_commands` must expose exactly the five project-owned Ralph commands, acknowledge abort, and resolve the extension symlink into the expected source or packed package. The check neither controls the daemon nor asserts provider or canonical-skill behavior.
- **RPC:** an LF-delimited client starts a session, sends `abort`, observes acceptance, and exits cleanly.
- **ACP initialization:** a JSON-RPC client completes `initialize` and `session/new`, receives protocol and session data, and closes at EOF.
- **ACP prompt:** a JSON-RPC client completes `initialize`, `session/new`, and `session/prompt`; the configured provider turn returns `end_turn`.

Run them from the package root:

```sh
npm run accept:public-setup-discovery
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

The setup-discovery check is public black-box evidence for source `init-loader`, `init-command-catalog`, and `package-installed-loader` only. It does not exercise `/reset`, `/spec-it-out`, or `/plan`; their lifecycle behavior requires separate spawned-transport proof. The existing mixed init/package fixtures remain package and gray-box compatibility evidence.

These checks do not prove every provider, prompt, tool, or long-running deployment. Reset and lifecycle acceptance provide separate pass-boundary and transcript-equivalence evidence.
