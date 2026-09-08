# 2026-08-22 — Auto-named sessions, unboxed activity, sub-agent rendering

Four chat-layer changes shipped together on the sidebar-polish branch (PR
#47).

## Session auto-naming

A new session's sidebar title used to be its first user message forever. Now,
after the first prompt of a fresh session (not a resume, not explicitly
named), Phosphor asks for a short capitalized title and applies it:

- `pi:generateTitle` (pi-session-handlers.ts) runs **`pi -p --no-session
--no-tools`** with a naming prompt — a one-shot completion against the
  user's default pi provider. `--no-session` keeps it out of the sidebar;
  `--no-tools` keeps a title request from touching anything. 30s timeout;
  every failure path returns null and the old behavior stands.
- The prompt carries the workspace's existing session titles so the model
  avoids duplicates; `dedupeTitle` adds a numeric suffix if it duplicates
  anyway. Prompt/sanitizer/dedupe are pure functions in
  `electron/pi/session-naming.ts` (tested).
- Renderer side (`autoNameSession` in stores/sessions.ts): fire-and-forget
  after the first prompt; guarded so an explicit rename (or a disposed
  session) always wins over a late generation.
- E2E-inert by design: the stub names every session via `get_state`
  (`sessionName: 'E2E stub session'`), and the explicit-name guard skips.

## Transcript skeleton

Was full-window-wide; now sits in the same `mx-auto max-w-3xl px-6` column as
the transcript it stands in for.

## Activity groups: box the tools, not the narration

The whole run (summary head + steps) was one bordered card. Now the summary
line (caret + "N steps · …") is an unboxed row and only the expanded step
list gets the bordered card. While live, the summary text uses the existing
`thinking-shimmer` and the accent dot pulses; settled groups get the rotating
caret. The `overflow-hidden` that clipped the grid-track collapse moved from
the outer frame to the body's `min-h-0` child — removing it entirely breaks
the collapse animation.

## Claude Code provider: sub-agents and call rendering

- `externalToolInfo` (transcriptRows.ts) reads the marker argument preview
  best-effort (see 04-chat.md — the preview is often truncated invalid JSON)
  and external-tool rows now show a human headline (query/path/description)
  instead of raw JSON spill.
- `Agent`/`Task` markers render as a dedicated sub-agent row (`agent` badge,
  description headline, prompt expandable) and summarize as "launched N
  agents". `trailingAgentLaunches` feeds a strip above the composer, shown
  until the user's next message.
- The strip deliberately makes no liveness claim and has no spinner: the
  provider forwards only the launch marker, with no progress and no
  completion.

> **Corrected 2026-08-22** — two claims above were wrong, and the strip's
> original wording ("N agents launched in background") was wrong with them.
> The CLI is only _force-killed_ on the break-early path, which fires for
> pi-executable tools; a sub-agent turn ends with the CLI exiting normally.
> More importantly the agent is not working "in the background" at all — it
> dies with that exit and never reports back. See
> [2026-08-22-claude-subagents-never-return.md](2026-08-22-claude-subagents-never-return.md)
> for the captured evidence and the corrected wording.
