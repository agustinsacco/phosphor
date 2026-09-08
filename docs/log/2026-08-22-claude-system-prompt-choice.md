# Choosing whose system prompt Claude Code sessions run under

2026-08-22

## Why

The pi-claude-cli provider spawned `claude` with `--append-system-prompt`, so
pi's system prompt layered on top of Claude Code's own. That inverts the point
of a minimal harness: pi's instructions arrive _in addition to_ another agent's
preamble rather than instead of it.

Upstream [rchern/pi-claude-cli#21](https://github.com/rchern/pi-claude-cli/pull/21)
swaps the flag for `--system-prompt` unconditionally. We wanted the option, not
the mandate — so the fork takes it as a setting
([agustinsacco/pi-claude-cli#14](https://github.com/agustinsacco/pi-claude-cli/pull/14),
v0.4.7) and Phosphor surfaces the choice.

## Sizing, measured

A real session's fixed cached prefix was **17,475 tokens**. The tool schemas in
there (~4.3k, per the context-breakdown extension's own numbers) are sent
regardless, so only Claude Code's prompt is replaceable. Pi's prompt after the
extension's tool-section rewrite is ~674 tokens, making the realistic saving
roughly **12k tokens of context window per call**.

Worth stating plainly because the surrounding work was about a runaway bill:
this is _not_ a cost fix. That prefix is cached and bills at 0.1x, so it was
never a meaningful part of the burn. It buys window, not dollars.

## What changed here

`AppPrefs.claudeSystemPrompt` (`'claude' | 'pi'`, defaulting to `'claude'`) with
`app:setClaudeSystemPrompt` to persist it. `pi:createSession` injects it as
`PI_CLAUDE_CLI_SYSTEM_PROMPT` in the spawn env — per session rather than once at
startup, so a change applies to the next session without restarting Phosphor.

Settings → Claude Code grows a two-option chooser above "Prove it end to end",
stating the trade in each option rather than burying it in help text. The
extension's `pi` mode rewrites pi's tool documentation (which names `read`,
`edit`, `oldText`, `newText`) into Claude Code's vocabulary (`Read`, `Edit`,
`old_string`, `new_string`), because leaving pi's names against Claude Code's
actual schemas is worse than useless.

## Sharp edges

- **Takes effect on the next new session.** Only the session-creating turn sends
  a system prompt; the CLI keeps it for the session's life. The UI says so.
- **Needs extension v0.4.7+.** Older versions ignore the env var and always
  append. The tab notes this rather than silently doing nothing.
- Default stays `claude`. Replacing the prompt leaves the model with pi's
  instructions plus raw tool schemas, and behaviour can differ — that is a
  choice a user should make deliberately.
