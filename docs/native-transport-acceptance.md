# Native transport acceptance

These checks prove that the packaged extension is admitted through real Prime Agent `0.9.1` transports. They are narrower than the unit and deterministic lifecycle suites.

## Committed checks

- **RPC:** an LF-delimited client starts a session, sends `abort`, observes acceptance, and exits cleanly.
- **ACP initialization:** a JSON-RPC client completes `initialize` and `session/new`, receives protocol and session data, and closes at EOF.
- **ACP prompt:** a JSON-RPC client completes `initialize`, `session/new`, and `session/prompt`; the configured provider turn returns `end_turn`.

Run them from the package root:

```sh
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

These checks do not prove every provider, prompt, tool, or long-running deployment. Native reset and lifecycle acceptance provide the pass-boundary and transcript-equivalence evidence.
