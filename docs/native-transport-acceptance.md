# Native transport acceptance

Native smoke tests check that the packaged extension can be admitted by real Prime Agent transports. They are intentionally narrower than the unit and fixture suites.

## Tested environment

The current Slice 3 rerun uses Prime Agent `0.9.1`. Earlier research also exercised `0.8.0`; those results are historical and do not replace the current peer-version gates. Do not copy machine-specific paths from an old report. Set the extension, working directory, and provider/model selection for the installation under test.

## Passing checks

- **JSON:** structured session, agent, turn, and message events were emitted and the process exited successfully.
- **RPC:** an interactive LF-delimited client admitted a prompt, sent `abort`, and observed clean exit.
- **ACP initialization:** a JSON-RPC client completed `initialize` and `session/new`, received protocol/session data, and closed at EOF.
- **ACP prompt:** a line-buffered JSON-RPC client completed `initialize`, `session/new`, and `session/prompt`; the provider-backed turn returned `end_turn`.
- **Text:** a disposable pseudo-terminal produced formatted output and exited successfully.
- **Daemon:** a disposable daemon reported protocol 7, schema revision 22, and version 0.8.0; versioned shutdown was accepted and the socket was removed.

## Reproduce the committed checks

From the package root:

```sh
npm run poc:native-rpc
npm run poc:native-acp
PRIME_RALPH_ACCEPT_PROVIDER=<provider> \
PRIME_RALPH_ACCEPT_MODEL=<model> \
npm run poc:native-acp-prompt
```

The scripts use the Prime Agent installation available in the test environment. The provider-backed ACP prompt smoke accepts an explicit provider/model pair and emits only bounded protocol diagnostics on timeout. Inspect each script's command-line options and environment requirements before running against another installation.

## Transport rules

- Use strict LF-delimited JSONL for JSON, RPC, and ACP clients.
- Buffer input by complete lines; do not assume one read equals one message.
- Use a fresh daemon socket for every disposable run.
- Shut down daemons through the protocol and verify socket cleanup.
- Run interactive text mode through a pseudo-terminal. Captured non-TTY subprocess output is not valid text-mode evidence.
- Keep native checks separate from package unit tests and fixture POCs.

## What this does not prove

These checks do not prove that every host configuration, model provider, prompt, tool, or long-running deployment is production-ready. The daemon check remains an operator procedure rather than a reusable package test because an earlier reusable harness encountered a binary private-frame startup race. That harness was intentionally not committed.
