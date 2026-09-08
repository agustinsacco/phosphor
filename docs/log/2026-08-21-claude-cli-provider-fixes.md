# 2026-08-21 — Claude Code provider: four gap fixes, live-verified

`@saccolabs/pi-claude-cli` went from "loads and answers" to first-class in
four releases. This is the Phosphor-side record; mechanics live in that repo's
`docs/ARCHITECTURE.md`, and every claim below was reproduced against **pi
0.84.2 + claude 2.1.237 on a real Max account**, not inferred.

The provider is an ordinary pi package to Phosphor — none of this required a
Phosphor code change. It matters here because Phosphor ships the catalogue entry,
the Claude Code settings tab, and the "Test provider" button that proves the
chain, so Phosphor support questions land on these behaviors.

## What was broken, and what fixed it

**Multi-cycle turns lost their answer (0.4.1).** Any turn where Claude ran
its _own_ tool — WebSearch, a user MCP server, ToolSearch — returned only
the preamble, with usage from roughly one cycle and stray later-cycle
thinking recorded as content. Two causes, one shipped fix:

1. _Root cause, found by A/B-ing the wire protocol._ The extension answered
   the CLI's permission requests in Claude Code **1.x** shape (`request_id`
   at the top level). 2.1.x **silently ignores** it — the CLI waits forever,
   the episode stalls, and the inactivity timer kills it mid-answer. The 2.x
   shape nests `request_id` inside `response` and carries `updatedInput` on
   allow. Replicated both ways: old shape → 2 cycles then hang; new shape →
   search executes, episode completes.
2. _Structural._ One subprocess run is an agentic **episode** (N API cycles
   with tool executions between), and SSE `content_block` indexes reset each
   cycle. The bridge now keys blocks by `(cycle, index)`, banks per-cycle
   usage at each `message_start`, takes the last cycle's stop reason, and
   trusts the `result` envelope's cumulative totals when present.

Also shipped: CLI-side tools now appear in transcripts as one-line markers
(`[Claude Code · WebSearch {"query":…}]`) instead of silence; a deduped
final-answer safety net from the `result` envelope; and the inactivity
timeout raised 180s → 300s (`PI_CLAUDE_CLI_TIMEOUT_MS`) because CLI-side
tools are legitimately silent on stdout for minutes.

**Forked sessions always failed (0.4.2).** A fork copies pi history into a
**new** session id, so the "has a prior provider turn" heuristic chose
`--resume` while the CLI cache was keyed to the old id — every forked turn
died with `No conversation found with session ID`. Since Phosphor forks
routinely (branch jumps, bookmarks), this broke a first-class flow.

`streamViaCli` became a driver over `runOnce(forceFullReplay)`: a resume
attempt that hits the resume-miss signature returns **without touching pi's
stream**, and the driver retries once with a full-history replay under
`--session-id`, which re-registers the CLI cache so later turns resume
normally. A subtlety only the live run exposed: the CLI also exits non-zero
after that result, and the abandoned attempt's async `close` handler raced
the retry and errored the stream — silenced via the existing `broken` guard.

**Context overflow didn't compact (0.4.3).** The CLI surfaces Anthropic's
overflow text verbatim (`prompt is too long: N tokens > M maximum`), which
pi doesn't recognize, so the turn hard-errored instead of compact-and-retry.
A provider-scoped `message_end` handler now rewrites overflow-shaped errors
with the `context_length_exceeded:` prefix pi's recovery matches — exactly
the pattern pi's custom-provider docs prescribe. The matcher is deliberately
narrow (two Anthropic phrasings) and never touches rate limits: rewriting
those would trigger compaction instead of pi's retry/backoff.

**The Claude environment leaked into every turn (0.4.3).** Without
`--strict-mcp-config`, each subprocess loads the user's personal/project MCP
servers, fires their hooks, injects project CLAUDE.md and memory, and can
double-load skills (natively via claude, again via pi's own
`~/.claude/skills` support). Often desirable, never visible.
`PI_CLAUDE_CLI_HERMETIC=1` now adds `--strict-mcp-config` plus an empty
`--setting-sources`; the schema-only custom-tools server and the
subscription login are unaffected. Both flags verified accepted on 2.1.237.
The fork's README gained a "What your Claude environment contributes"
section naming the three doors (bridged tools / CLI-side execution /
prompt-level osmosis).

## Verification

- 322 unit tests, including `tests/fixtures/multi-cycle-episode.jsonl` — a
  **real captured three-cycle episode** — asserting content ordering, tool
  markers, cumulative usage, and per-cycle summing when an episode ends
  without a `result`.
- Live smokes (they spend plan quota, so they are documented rather than
  automated): fresh turn, `-c` resume, `--fork`, a web-search turn returning
  a real headline plus `MULTI-DONE` with episode-total usage, and a
  break-early `write` round-trip proving pi still executes pi-owned tools.
- Fork CI: lint/typecheck/tests on three OSes plus a stub e2e against pinned
  pi and a `pi@latest` canary (weekly cron).

## Release-process note (bit us once)

Publish runs on every push to `main` and publishes when `package.json`'s
version is new to npm. Three PRs merged in sequence where only the **first**
carried a version bump: it published 0.4.2, and the other two merges were
green **no-ops** — their code sat on `main`, unpublished, while npm and the
release both said 0.4.2. Caught by unpacking the published tarball and
finding `src/overflow.ts` absent.

Rule going forward: either the **last** merged PR carries the bump, or push
a separate `chore: <version>` commit after the batch lands (what 0.4.3 did).
When in doubt, verify with `npm pack <pkg>@<version>` and grep the tarball —
a green publish run only means "nothing new to publish".

## Still open

Deferred by choice: running Claude Code as an autonomous **sub-agent** via
ACP (see `EXTENSIONS_PLAN.md` WS5) — the research is banked, the trigger to
reopen is wanting Claude Code's own agentic behavior inside a Phosphor session
rather than Claude models inside pi's loop. Also unmeasured: cost figures
are computed at API list prices while the user actually spends plan quota,
so Phosphor's totals overstate real cost for this provider.
