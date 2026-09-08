# Connecting a connector no longer needs a session

Date: 2026-08-27

## What changed

Yesterday's Connectors tab could add a connector with nothing running, but
**Sign in** was disabled until a session existed — because the OAuth flow is an
MCP-adapter extension command and extension commands need a pi process. That
gate landed on the exact moment people use the tab: a fresh launch, no session,
setting the app up.

Now Settings authorizes on its own. `mcp:authorize` spawns a throwaway
`pi --mode rpc --no-session` in the main process
(`electron/pi/connector-auth.ts`), sends `/mcp-auth <server>`, opens the
browser, pushes progress on `mcp:authState`, and kills the process when the
flow settles. Still no tokens spent — an extension command runs no model — and
still no credential in Phosphor: the adapter writes them to the OS credential
store as before.

The in-session route stays, because it is not the same thing. The adapter
auto-authenticates _mid-turn_ when a model calls a tool whose server has no
token, so that prompt arrives on a live session's channel and must land in the
same card. `stores/connectors.ts` now has both paths and one card.

## Why `--no-session` is the load-bearing flag

A connector flow must not look like work. Without `--no-session` the throwaway
process would write a session file (sidebar row) and, if it went through
`SessionRegistry`, be projected by the fleet hub as a live session. It goes
through neither: `PiRpcClient` directly, ephemeral, disposed on settle — the
same machinery `model-catalogue.ts` uses to ask pi one question with nothing
running.

## The bug the test found

`startConnectorAuth` returns a promise that resolves when the flow settles.
Cancelling cleared the run and disposed the client, but never settled that
promise — so an awaiting caller hung forever, holding the process handle with
it. The cancel test caught it immediately (a 5s timeout with nothing else
wrong), and `ActiveRun` now carries its own `finish`, which cancel calls with no
state: the promise resolves, the process dies, and the UI is not told about a
phase it already dropped.

Cancel is also still the _only_ place Phosphor answers the adapter's prompt. The
rule from [reference/mcp.md](../mcp.md#connectors-settings--connectors)
is unchanged and now has a second guard: the "manual" mode of the new fake pi
only succeeds if the client answers the prompt, so the test asserting that
Phosphor does **not** answer is a test that would fail if a future refactor
"tidied up" the pending request.

## Parsers moved to shared/

`parseOAuthPrompt` / `parseAuthNotice` were renderer-only; main now reads the
same adapter strings, so they live in `shared/connectors.ts`. One copy, per the
one-fact-one-home rule — two would drift the moment the adapter reworded a
message.

## Smaller honesty fixes

- A configured connector with no live session now reads **state unknown**
  instead of showing nothing, because per-server status genuinely requires the
  adapter to be running.
- Disconnecting with no session removes the config but does not claim to have
  logged out; `/mcp logout` needs a process, and the tokens are cleared by the
  next session that runs it.

## Verification

`typecheck`, `lint`, `prettier --check .`, 1337 unit tests (85 new since the
connectors work started, including 7 that drive a real pi-protocol child
through the whole flow), and the e2e suite with a second Connectors case that
signs in with **no session open** — the stub answers `/mcp-auth` with the
adapter's real prompt shape, and `openExternal` is skipped while the stub is
active so CI never launches a browser.
