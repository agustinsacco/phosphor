# The idle-session reaper, reload re-adoption, and stats without polling

2026-09-01

Phases 2 and 3 of
[specs/backlog/session-resource-management.md](../specs/backlog/session-resource-management.md),
landing the same day as Phase 1
([log](2026-09-01-session-scan-and-ipc-trims.md)). This half changes what the
user sees; Phase 1 deliberately did not.

## The idle-session reaper (S1)

Every `pi --mode rpc` subprocess costs ~200 MB RSS idle or busy (MEASURED:
602 MB for three doing nothing), and nothing ever reclaimed one —
`registry.dispose` was reached only by explicit user action or quit. Ten open
lanes was ~2 GB, permanently.

`electron/pi/session-reaper.ts` adds the policy on top of the suspend
mechanism that already existed: **cap + idle grace**. At most N live sessions
(default 4); past the cap, sessions idle longer than the grace (default
15 min) are suspended, least-recently-active first. Both conditions must
hold — the cap alone can take a session touched seconds ago, the grace alone
leaves ten rotating lanes holding ~2 GB. A reaped session keeps its sidebar
row (marked suspended, same as the manual context-menu suspend) and reopening
resumes from disk in about a second.

Three design decisions worth recording:

- **It lives in main, driven by the fleet hub.** The hub already derives
  phase, `lastActivityAt`, `idleSince` and `pendingQuestion` per live session
  from events Phosphor receives anyway, so the reaper adds zero RPC and zero
  inference. Main-side is also what makes it survive the renderer (see S2).
- **The eligibility list errs on keeping sessions alive**, because the failure
  mode is destroyed user work, which is strictly worse than the memory it
  saves. Never reaped: the active session (the renderer reports it over
  `pi:setActiveSession`), anything streaming / awaiting input / exited,
  anything holding a pending question, the orchestrator, any session with a
  live PTY (its shell may be mid-build — disposal kills PTYs), and anything
  whose diskPath is unknown (it could not be resumed). Composer drafts key on
  the session's disk path, so they survive.
- **The grace is a belt on top of the phase suspenders.** It applies to
  `lastActivityAt` as well as `idleSince`: phase is derived state and could in
  principle be wrong, but `lastActivityAt` moves on every event a session
  emits, so a genuinely streaming session can never look idle-past-grace.

The renderer learns about a reap on the session's own push channel (a new
`reaped` SessionPush kind) and runs the same local cleanup as a user-invoked
dispose — minus the `pi:disposeSession` call, since the process is already
gone. Settings (enable, cap, grace) live under Settings → Advanced → Session
memory and are read per sweep, so changes apply without a restart.

**Deviation from the plan:** it ships enabled by default, where the plan said
default-off-then-flip. The plan's caution was "a wrong policy destroys user
work"; with the eligibility list above plus the double time guard, the worst
case left is a suspended idle session costing ~1 s to reopen, and a
default-off reaper reclaims nothing for anyone. The off switch stays.

## A renderer reload no longer orphans live sessions (S2)

The registry lives in main; the renderer's `live` map is plain store state. A
reload — HMR, a crash, re-navigation — used to give the renderer an empty map
while every child kept running until quit. Worse, resuming the last session
then spawned a **second** pi process against a file an orphan still owned.

`pi:listLiveSessions` (rebuilt — the old channel of that name had been deleted
with zero callers) reports main's live sessions with the fleet hub's
`diskPath` and `isOrchestrator`. App boot re-adopts every non-orchestrator
via the same `adoptSession` path the orchestrator always used, **before**
`app:resumeTarget` is consulted; a resume target that matches an adopted
session's diskPath activates it instead of spawning a duplicate.

Guarded end to end: the new e2e test starts a session, reloads the renderer,
and asserts the same pid list — one process, the original — through the real
IPC surface.

## Stats from the stream instead of ~26 round trips per turn (S5)

`get_session_stats` was polled on every completed sub-step to keep the context
meter climbing — MEASURED at 26.0 round trips per user turn across the 12
largest well-formed sessions here (2 for a short chat, 91 for a tool-heavy
run). Since pi 0.84.2, `message_update` carries usage for free.

Two facts were read from pi 0.84.4's source, not guessed, and both shaped the
design (`src/lib/liveStats.ts`):

- **`message_update.usage` is the CURRENT MESSAGE's usage** (`json-event.js`
  forwards `event.message.usage`), cumulative as of the delta — not
  session-cumulative. pi emits one assistant message per tool hop, so summing
  deltas naively would count a turn once per hop. The module keeps
  `base + current`: base re-seeds from every authoritative poll and advances
  on each `message_end`'s final usage; current is the streaming message.
- **pi's context estimate is** `usage.totalTokens || input+output+cacheRead+
cacheWrite` **of the last assistant usage** (`calculateContextTokens` /
  `estimateContextTokens`), plus a trailing term that is zero while that
  message is the latest — which during streaming it always is. The live meter
  uses exactly that formula against the window the last poll reported, so it
  cannot drift from pi's own compaction math. (`totalTokens` was added to the
  `Usage` mirror as optional.)

Capability is **detected, not version-checked**: the first delta carrying
usage flips the session to boundary-only polling (`agent_end`,
`compaction_end` — where pi computes things the stream cannot carry). pi <
0.84.2 never flips it and keeps the old per-sub-step polling, so the meter
still works there. Phosphor does not control which pi is installed; the machine
this was built on runs 0.84.1 and exercises the fallback.

Burn-rate samples now come from the same accounting (`liveBilledTokens`,
session-cumulative and monotonic across message boundaries).

## The session-dir watcher got the fd budget too (S9)

Same per-file fd cost as the workspace watcher, previously unbounded at
`depth: 0`. Now capped at `MAX_WATCHED_SESSION_FILES = 2000` per directory
with the same stats-gated idempotent `ignored` contract, plus an error handler
so a watcher error can never become an uncaught exception in main. The
2026-08-31 fd-budget log's "not worth it today" call on this file is
superseded; that entry now points here.

## Verification

typecheck, lint, prettier, 1772 unit tests (152 files; 32 new across reaper
policy, sweep side effects, live-stats accounting, reaped-push cleanup, watch
budget), and 35 e2e specs including the new reload-re-adoption test.

Not verifiable on this machine: the usage-on-deltas fast path against a live
pi (installed is 0.84.1; the capability is exercised by unit tests and the
fallback by everything else). First run on ≥ 0.84.2 should sanity-check the
meter against `/stats` in a real session.
