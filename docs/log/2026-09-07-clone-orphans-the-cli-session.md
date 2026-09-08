# Clone orphans a Claude CLI session, and a parked process re-bills a commit

_2026-09-07_

An audit of one long `pi-claude-cli` lane — pi session
`01a07ecb-f990-7149-879a-dcc27b874128`, four and three quarter hours, two
models, `~$62` of reported spend — asking one question: did the whole thing
stay inside a single Claude Code session over `--resume`?

**It did not.** The lane ran on two CLI sessions, and the break was caused by
pidex's own sidebar **Clone**.

## 1. Clone changes the pi session id, and the mapping is keyed on it

`@saccolabs/pi-claude-cli` keeps one CLI session per pi session and resumes it
across turns and pi restarts. The map is a flat file
(`~/.pi/agent/pi-claude-cli/session-map.json`) keyed by **pi session id**.

`cloneSession` in `src/features/sessions/sidebarActions.ts` sends pi's `clone`,
which is `fork(leafId, { position: 'at' })` — a full-history branch onto a
**new session file with a new pi session id**. The map lookup then misses, so
the provider does not resume anything. It starts a fresh CLI session and
replays pi's entire transcript into it as one user message.

Measured on this lane:

|                                  |                                               |
| -------------------------------- | --------------------------------------------- |
| pi session before the clone      | `01a07dbb-…f9` → CLI `a48dc146-…48`           |
| pi session after the clone       | `01a07ecb-…28` → CLI `86b27486-…c4`           |
| clone                            | 02:14:52Z, 9 s after the session was reopened |
| replayed history                 | 83,180 characters, one user message           |
| first request of the new session | 64,108 cache **write**, 10,604 cache read     |

Nothing was lost from the conversation — the replay carries it — but the CLI's
cached prefix, its own transcript, and its accumulated tool results all start
again from zero.

Two consequences worth naming:

- **A clone is not free on this provider.** On a native pi provider it copies a
  file. Here it also costs a full-context cache write and forfeits the cached
  prefix the session had built.
- **The pre-clone CLI transcript is a separate ledger.** Deleting the pre-clone
  session row (`electron/pi/session-deleter.ts`) trashes both halves of it. On
  this lane that happened at 03:03Z and took the first four hours of
  per-request cache evidence with it, leaving only the orphaned
  `a48dc146-…/tool-results/` sidecar the deleter does not touch.

## 2. Inside a CLI session, caching behaved — once

The surviving transcript (158 requests, 02:14Z–03:02Z) reads clean:
`cache_read_input_tokens` climbs monotonically, `cache_creation` stays at the
per-request delta, and every entry is `ephemeral_1h`, not `5m`. Totals:
30,817,961 cache read against 393,642 cache write.

One request breaks the pattern. At 02:29:58Z cache read collapses from 102,471
to 10,134 and 96,971 tokens re-bill as a write. The cause is the pair the
repo already knows about, arriving together:

- The turn gap was **10 m 47 s**, just past `DEFAULT_KEEPALIVE_MS` (600,000) in
  the provider, so the parked CLI process exited and the next turn spawned a
  fresh one.
- Commit `7a42be3` landed at 02:18:56Z, inside that gap. Claude Code's own
  system prompt embeds a git snapshot, and it is rebuilt per process — so the
  new process carried a different prefix, invalidated at the ~10 k mark where
  that snapshot sits.

pi's own system prompt is not implicated: the provider stores it per CLI
session (`sysprompt/<id>.txt`, written once at creation) and replays it
verbatim. Both files here are single-write.

A 5-minute idle either side of that commit would have cost nothing. The park
window is the exposure, and it is 10 minutes wide.

## 3. One turn was billed and returned nothing

At 01:27:23Z, after a 3 h 38 m idle, an assistant entry landed with empty
content, `stopReason: "stop"`, `output: 4` — and `cacheWrite: 229,913` with
`cacheRead: 0`. The full context re-write is expected after that long an idle;
the empty reply is not. Reported cost: `$1.44` for nothing. The user switched
model and typed "continue", which paid a second full write (278,666) — that
one unavoidable, since a model change invalidates the prefix anyway.

The signature matches the post-compaction stall in
[2026-09-03](2026-09-03-post-compaction-stall-and-context-meter.md), fixed in
provider 0.6.1; 0.7.0 was installed here, so this is either a different path to
the same empty `result` or a plain API failure. The CLI transcript that would
say which was deleted with the pre-clone session (§1).

## What to change

- `cloneSession` should either carry the CLI-session mapping onto the new pi
  session id, or tell the user what a clone costs on this provider. Silently
  reimporting a 280 k-token conversation is the worst of the three.
- A session's Claude-side identity is worth surfacing where the pi session id
  already is, so a lane that quietly started a second CLI session is visible
  without reading `session-map.json`.
