# 2026-08-22 — Claude Code sub-agents never report back

> **Superseded 2026-08-28.** The cause was not the CLI: it was one SIGKILL
> in the provider, at a `result` that ends a cycle rather than the episode.
> `pi-claude-cli` 0.4.14 waits, and background agents now report back — see
> [2026-08-28-subagents-report-back.md](2026-08-28-subagents-report-back.md).

## The symptom

A Phosphor session on the Claude provider was asked to investigate two bugs. It
spawned a sub-agent, said _"I've launched an exploration agent… I'll report
back once it finishes"_, and then nothing happened. No results, no spinner,
no error — just an empty transcript below the message.

## What actually happened

Both sides of the conversation are on disk, and they agree.

Claude Code's own record for that session
(`~/.claude/projects/-home-agustinsacco-src-agustinsacco-Phosphor/01a0271c-0d77-7234-a773-c7944db03c7a.jsonl`)
is **15 entries long** and ends like this:

| entry | content                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11    | `tool_use: Agent` (`description`, `prompt`, `subagent_type`)                                                                                        |
| 12    | `tool_result`: _"Async agent launched successfully… The agent is working in the background. You will be notified automatically when it completes."_ |
| 14    | assistant text: _"I've launched an exploration agent…"_                                                                                             |
| —     | **end of file.** No notification, no results, never resumed.                                                                                        |

pi's session file for the same conversation
(`~/.pi/agent/sessions/--home-agustinsacco-src-agustinsacco-Phosphor--/2026-08-22T01-35-45-015Z_01a0271c….jsonl`)
holds one assistant message with two text blocks — the `[Claude Code · Agent
{…}]` marker and the prose — and `stopReason: stop`. The turn was over.

## Why

That tool result's promise ("you will be notified automatically") assumes the
long-lived harness the CLI normally runs inside: it stays up, the agent
finishes, the harness re-invokes the model with the result.

Phosphor has no such harness. The provider runs `claude -p` as a **model server
spawned per turn**, so the process exits as soon as the turn's answer is
complete, and the sub-agent dies with it. pi drives the loop and has no
concept of a pending background task, so nothing re-invokes anything. The
model's promise to report back was structurally impossible to keep.

Note the mechanism precisely: `process-manager.ts` force-kills the CLI only
on the **break-early** path, which fires at `message_stop` when a pi-known
tool was seen (pi is about to execute those itself). `Agent` is not
pi-known, so break-early does not fire here — the CLI simply exits normally
at the end of the turn. Either way it does not outlive the turn.

## What this repo changed

Rendering only. The `Agent`/`Task` marker now renders as a sub-agent row and
summarizes as "launched N agents" (see
[2026-08-22-chat-polish-and-auto-naming.md](2026-08-22-chat-polish-and-auto-naming.md)),
verified by replaying the capture above through `buildTranscriptRows`:

```
name       : Agent
isAgent    : true
headline   : "Find chat rename and sort code"
prompt     : NOT recoverable (provider truncated it mid-string)
summary    : "launched 1 agent"
stripCount : 1
```

The composer strip's **wording** was the bug this write-up fixes. It read
"N agents launched in background", which says work is in flight; the capture
proves none is. It now says the sub-agents were started but will not report
back, and suggests asking again — the honest and actionable framing. A
spinner and a "running" count would both have been inventions.

## What a real fix needs (provider work, `pi-claude-cli`)

Nothing in Phosphor can make these agents work; the provider has to change
first. Two routes, the second preferred:

1. Keep the CLI alive while background agents are pending and feed the
   completion notification back into pi as a new turn.
2. **Bridge `Agent`/`Task` as synthetic pi tool calls**, so pi's own loop owns
   the wait. This also _normalizes_ Claude sub-agents with the `pi-subagents`
   extension, which already works correctly for exactly this reason: those
   are real pi tools, so pi sees the call, waits for it, and Phosphor renders it
   as an ordinary live tool card with a real loading state.

Live progress additionally needs the `parent_tool_use_id` events the provider
currently drops (`provider.ts` forwards top-level events only). Once results
actually return, the UI affordances become buildable on real signals: "2
agents running", per-agent transcripts in the right pane, and a working
indicator that persists while the orchestrator waits.
