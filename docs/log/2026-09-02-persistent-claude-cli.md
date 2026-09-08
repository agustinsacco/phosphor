# Claude sessions re-billed their whole context after every commit; the provider now keeps one CLI process per session

**Requires `@saccolabs/pi-claude-cli` >= 0.7.0**
([PR #34](https://github.com/agustinsacco/pi-claude-cli/pull/34)). Phosphor itself
did not change behaviour for this; the fix lives in the provider, and this
entry records the cause so nobody re-derives it.

## What the audit found

Session `01a05d22` (2026-09-01, 22 turns, 198 API calls, $48) had three
full-context cache misses inside the 1h TTL. Each time `cache_read` fell to
exactly the CLI's built-in-tools prefix (~15.9k tokens) and everything after
was rewritten: 64k, 106k and 190k tokens. The same pattern showed in two other
sessions that day, 10 misses and 1.87M cache-write tokens in total.

The multiplier was that pi-claude-cli started a fresh `claude -p --resume` on
every pi-side tool call and every user turn. Claude Code rebuilds its system
prompt per process, and that prompt embeds a git snapshot: status, recent
commits, branch. Two of the three misses line up with a git change between
processes:

- 13:22:54 Phosphor renamed the branch after auto-naming the session; the next
  process (13:23:27) missed.
- 13:30:00 the model committed and pushed; the next process (13:38:20) missed.

Reproduced deterministically against the real CLI (haiku, scratch repo): a
commit, a branch rename, or a new untracked file between two `--resume`
processes drops `cache_read` to the static prefix every time. Inside one
long-lived process the same changes cost nothing (E1/E3 in the investigation).
The third miss coincided with a 3 s MCP connect (normally 30 to 50 ms) and a
different deferred-tool state; a slow connect alone did not reproduce it, so
that one stays CLI-internal, but it needs a restart to happen at all.

pi's own tool surface did not change (schema temp file byte-identical, no
regeneration logged), and the stored system prompt is byte-stable across
resumes. Kill-and-resume itself was cache-continuous; only the prompt content
changed.

## What the provider does now (0.7.0)

- Custom (handoff) tool calls are allowed, not denied. The schema-only MCP
  server proxies `tools/call` over a local socket back to pi, pi runs the tool
  as before, and the next pi call answers the CLI on the same process. The CLI
  transcript records a real `tool_result` instead of the rejected-tool /
  `[Request interrupted]` / `No response requested.` filler we saw on every
  custom tool call.
- After `result` the process is parked (`PI_CLAUDE_CLI_KEEPALIVE_MS`, default
  10 min) and the next user turn goes to the same stdin.
- Live proof: one process through a handoff and a commit costs 131 then 91
  cache-write tokens; the old per-turn process re-bills 8,827 after the same
  commit.

## What it means for Phosphor

- Install and require `>= 0.7.0` (see CLAUDE.md). Nothing in Phosphor has to be
  set; `PI_CLAUDE_CLI_STRICT_MCP=1` and the autocompact pref pass through
  unchanged.
- Memory: one live CLI process per active Claude session (150 to 300 MB) for up
  to the keepalive window, on top of pi's ~200 MB. The session reaper's
  15-minute idle grace already bounds live pi processes; a parked CLI dies with
  pi because its stdin is a pipe from pi.
- The branch rename after naming still changes the git snapshot, but with a
  live process it is never rebuilt, so it no longer costs a rewrite. If the
  process is ever restarted after a rename or commit (idle retire, model
  switch), that one restart pays the rewrite as before.

## Two things this did not fix

- `claudeAutocompact` is set to `400k` in this install, so contexts reached
  315k and cache reads were 63% of the session's cost ($30 of $48). That is
  the user's trade-off, in Settings, not a bug.
- pi's own compaction fires after most Claude turns because pi-ai's silent
  overflow check is `input + cacheRead > contextWindow`, and the provider
  reports `cacheRead` summed over every internal API call of the turn (1.5M to
  14M against a 1M window). The compaction changes nothing in the CLI's
  context and costs two summarizer runs each time. Separate fix, in the
  provider's usage reporting or upstream in pi.
