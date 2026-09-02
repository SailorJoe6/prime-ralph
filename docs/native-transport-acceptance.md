# Native transport acceptance

This record separates native Prime Agent transport evidence from the standalone unit and fixture tests. The tested host is Prime Agent `0.8.0`; the extension is loaded with `-e /home/sailorjoe6/prime-ralph/src/index.js`.

## Passing evidence

- **JSON:** `prime-agent --mode json --offline --no-extensions -e ... --cwd ...` produced structured session, agent, turn, and message events and exited 0.
- **RPC:** An interactive LF-delimited client sent `{"id":"p","type":"prompt","message":"status"}` and then `{"type":"abort"}`. The prompt was accepted, the abort was accepted, and the process exited 0.
- **ACP initialization:** A JSON-RPC client sent `initialize` and `session/new`; protocol version 1 and a session ID were returned, and EOF exited cleanly.
- **ACP prompt:** A strict LF parser sent `initialize`, `session/new`, and `session/prompt` with a text-content array. The provider-backed turn returned `stopReason: end_turn`.
- **Daemon:** A disposable daemon was started with a unique socket, `--mode daemon`, `--daemon-socket`, and the packaged extension. Its `daemon_hello` reported protocol 7, schema revision 22, and app version 0.8.0. A versioned `shutdown` command was accepted and the socket was removed.

## Boundaries

The JSON/RPC/ACP checks are committed as reproducible smoke scripts. The daemon check remains an operator-host probe rather than a package script: an attempted reusable harness encountered a binary private-frame race during daemon startup, so it was deliberately not committed as flaky acceptance. The default daemon socket may also already be owned by a running user service; disposable tests must always use a unique socket and must shut it down through the daemon protocol. Interactive `text` mode requires a TTY and is not represented by captured subprocess output.
