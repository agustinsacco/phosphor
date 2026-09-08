# Removing the pi/claude system-prompt choice

2026-08-30

## Why

[specs/log/2026-08-22-claude-system-prompt-choice.md](2026-08-22-claude-system-prompt-choice.md)
added a Settings → Claude Code toggle: run Claude-provider sessions under
Claude Code's prompt with pi's appended (`claude` mode, the default), or
under pi's prompt alone (`pi` mode, replacing Claude Code's entirely).

Re-verifying [pi-claude-cli 0.4.16](https://github.com/agustinsacco/pi-claude-cli/pull/28)
(see
[specs/log/2026-08-29-claude-cli-lifecycle-verification.md](2026-08-29-claude-cli-lifecycle-verification.md))
turned up how fragile the mechanism carrying either mode actually is: pi's
system prompt silently never reached the model at all, in either mode, for
the entire time this provider has supported one. That is a strong argument
for shrinking the number of system-prompt code paths that have to work
correctly, not growing them.

Re-examining `pi` mode's actual payoff on that basis: the 2026-08-22 doc
measured it as freeing roughly 12k tokens of context **window**, not cost —
both modes are cached and bill at 0.1x either way. In exchange, `pi` mode
drops Claude Code's own tuned guidance for its native tools, which matters
specifically for this provider because it runs Claude Code's built-in tools
(Read/Write/Edit/Bash/Grep/Glob) natively inside the CLI, not through pi. A
window saving with no cost benefit was not worth the doubled surface for a
bug class that had just cost a full day to find and fix.

## What changed

- Real sessions always run pi-claude-cli's own default (`claude`, append
  mode) — Phosphor no longer passes `PI_CLAUDE_CLI_SYSTEM_PROMPT` when spawning
  one. Removed: the Settings → Claude Code "System prompt" section, the
  `claudeSystemPrompt` pref (`AppPrefs`, `electron/store.ts`), the
  `app:setClaudeSystemPrompt` IPC channel, and the `ClaudeSystemPromptMode`
  type.
- The session-naming print-mode run keeps its own internal `pi` override
  (`electron/ipc/pi-session-handlers.ts`) — narrow and unaffected by the
  argument above, since a title request calls no tools, so there is no
  native-tool guidance to lose by replacing the prompt outright.

## Not touched

The underlying `PI_CLAUDE_CLI_SYSTEM_PROMPT` env var and both modes still
exist in the extension (`system-prompt-mode.ts`) — this is a Phosphor-side
removal of the _user-facing choice_, not a change to the extension's own
default or capability.
