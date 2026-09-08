# 2026-08-29 — Token overhead audit of Claude-provider sessions, and the two fixes that live here

A per-request token audit of two real pi-claude-cli sessions (Opus 5), each
cross-read against its Claude CLI transcript in `~/.claude/projects/`, plus a
control set of plain Claude Code sessions on the same machine. Question asked:
does Claude Code spend more tokens through Phosphor than it would on its own?
Answer: yes, ~25% of list-price cost per session was avoidable, from three
causes. Two are fixed in this diff; the largest lives in the provider package.

## What the transcripts showed

| Cause                                                                                                                                                                                                                                                               | Cost                                                                                        | Where it lives                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Turn-boundary cache loss — **root cause later corrected, see below**: the provider passed `--system-prompt` only on the session-creating spawn, and the CLI does not persist it across `--resume`, so turn 2 rebuilt the request under Claude Code's default prompt | **~35,000 tokens** re-billed as 1h cache _write_ (2× base), once per session (not per turn) | `@saccolabs/pi-claude-cli` — **fixed in 0.4.15**, not here |
| CLAUDE.md billed twice: pi embeds it in `<project_context>` in its system prompt, and the Claude CLI loads the same file again as memory                                                                                                                            | **+4,890 tokens on every request** (this repo's CLAUDE.md)                                  | fixed here                                                 |
| Session auto-naming ran a full-fat `claude -p` on the default model (Opus): full Claude Code prompt, skills, MCP instructions, agent listings                                                                                                                       | **~35,000 tokens per new session** for a ~15-token title                                    | fixed here                                                 |

Static prefix was _not_ bloated: a Phosphor session's first-call prefix measured
31,698 tokens vs 33,421 for plain `claude -p` in the same worktree. Of the
bundled extensions only `artifacts.ts` is model-visible (~90 tokens of
deferred tool names eagerly; schemas load on demand). `context-breakdown`,
`mcp-status`, `worktree-paths` and `tool-name-guard` cost zero — they are
`ctx.ui.setStatus` and event hooks.

One measurement trap for anyone repeating this: the Claude CLI transcript
duplicates assistant rows 2–3× per request. Dedupe on `requestId` before
summing `usage`, or everything overcounts ~2.5×.

> **Correction (same day).** The first row above originally read "median
> ~35,300 tokens per user turn, on ~71% of boundaries", blamed on
> kill-and-resume re-serializing the transcript. Direct measurement with a
> shimmed `claude` disproved that: steady-state boundaries cost 21–173 tokens,
> and kill-and-resume is cache-continuous. The real cause was a single dropped
> flag, costing one rebuild per session rather than one per turn. The 71%
> figure came from a sample dominated by short sessions, where turn-2 swaps and
> 1h TTL expiries were most of the boundaries. Full evidence and the shipped
> fix: [2026-08-29-claude-cli-lifecycle-verification.md](2026-08-29-claude-cli-lifecycle-verification.md).
>
> **Second correction (same day, after live re-verification with real API
> limits).** The 0.4.15 fix cited above re-sent `--system-prompt` on resume,
> which fixed the cache-cost math in this row. But that flag takes a
> **literal string**, not a path, and the provider has always passed it a
> temp-file path — since before this audit, on every turn including the
> first. So the "once per session, not per turn" framing above understates
> it: pi's instructions never reached the model at all, turn 1 included, on
> either `PI_CLAUDE_CLI_SYSTEM_PROMPT` mode. Fixed in **0.4.16**
> ([PR #28](https://github.com/agustinsacco/pi-claude-cli/pull/28)). This
> table's dollar figures are unaffected — the cache math was already right —
> but "fixed in 0.4.15" in the row above should read 0.4.16. Full account:
> [2026-08-29-claude-cli-lifecycle-verification.md](2026-08-29-claude-cli-lifecycle-verification.md#second-bug-found-on-live-re-verification-the-flag-was-always-wrong).

## Fix 1: `--no-context-files` for Claude-provider spawns

`spawnSession` now asks `usesClaudeCliProvider()` (electron/pi/provider-detect.ts)
whether the spawn lands on `pi-claude-cli` — explicit provider first, then a
`provider/id` model pattern, then pi's merged `defaultProvider` — and passes
`--no-context-files` when it does. The Claude CLI's own memory load becomes
the single copy of CLAUDE.md.

The detection is deliberately conservative because pi's bare model patterns
fuzzy-match across providers: a false negative costs the status-quo duplicate,
a false positive would strip CLAUDE.md from a provider that has no copy of its
own. Known trade-off, accepted: pi's prompt is fixed at spawn, so a session
switched to a non-Claude provider mid-conversation runs without pi's
CLAUDE.md block.

## Fix 2: the naming run is stripped and pinned to Haiku

`pi:generateTitle` now runs with `titleArgs()` (electron/pi/session-naming.ts):
`--no-tools --no-context-files --no-skills --no-prompt-templates`, plus —
when pi's default provider is the Claude CLI — `--provider pi-claude-cli
--model claude-haiku-4-5` and env `PI_CLAUDE_CLI_HERMETIC=1` +
`PI_CLAUDE_CLI_SYSTEM_PROMPT=pi`, so the run also skips Claude Code's own
prompt, skills, settings and MCP servers. Naming stays best-effort: a
model-resolution failure logs and returns null, same as any other naming
failure.

Two findings from live-testing the argv before shipping it:

- **`--no-extensions` must not be in this list.** Providers register through
  extension discovery, so `-ne` makes `pi-claude-cli` an unknown provider
  and the run errors out — which, naming being best-effort, would have been
  a silent regression to never-named sessions. The flag was in the first
  draft of this change and was caught only by running the argv against real
  pi.
- Measured after: 18,529 cache-creation tokens on Haiku (the Claude CLI's
  built-in tool definitions survive every strip available from this side —
  that floor lives in the provider/CLI). Roughly $0.04 per naming run at
  list price, down from ~$0.19 — a ~5× cut, most of it from Opus → Haiku.

## Not fixed here: the per-turn kill/resume

The dominant cost — the cache collapse at turn boundaries — is the provider's
per-turn process lifecycle and cannot be fixed from this repo. The validated
direction is a persistent CLI process (with an executing MCP bridge replacing
the schema-only server). Until that ships in `@saccolabs/pi-claude-cli`,
every Phosphor Claude session still re-bills its transcript on most user turns;
the fixes here trim roughly a third of the measured waste.
