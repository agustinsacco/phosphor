# Session scanning stops re-reading the whole file every turn

2026-09-01

Phase 1 of `specs/backlog/session-resource-management.md`, since deleted at zero
open findings.
Five changes, no behaviour change intended, all on the filesystem and IPC cost
of managing pi sessions. The memory half of that plan (the idle-session reaper)
is Phase 2 and is not in this change.

## The one that mattered

`parseSessionFile` re-read a session file from byte 0 whenever it changed. The
scanner's cache keys on `(mtimeMs, size)` and pi appends at the end of every
turn, so both keys moved every turn and the whole transcript was parsed again.
O(file) per turn is O(n²) over a session's life.

MEASURED across all 112 real session files on this machine, counting one
re-parse per persisted assistant message: **25 MB on disk cost 815 MB of
re-parsing**, with one 1.33 MB session re-read 132 times over.

Session files are append-only, so the fix is to parse only the new bytes.
`session-fold.ts` now holds the fold — `foldLine`, `foldFrom`, `metaFromFold` —
and the scanner keeps a second, much smaller cache of resumable parses.

MEASURED after, replaying ten real sessions turn by turn through the real
scanner (old path vs new, both appending):

| Session     | Turns | Before  | After  |          |
| ----------- | ----- | ------- | ------ | -------- |
| 3.56 MB     | 126   | 363 ms  | 37 ms  | **9.7×** |
| 1.46 MB     | 112   | 190 ms  | 28 ms  | 6.8×     |
| 1.33 MB     | 177   | 246 ms  | 39 ms  | 6.3×     |
| 0.70 MB     | 138   | 126 ms  | 30 ms  | 4.2×     |
| 0.96 MB     | 18    | 10 ms   | 6 ms   | 1.6×     |
| **All ten** |       | 1160 ms | 209 ms | **5.5×** |

The win scales with turn count, which is the point: the longer a session runs,
the more the old path re-read.

## Proving the append rather than assuming it

An incremental parse that is quietly wrong is worse than a slow one —
`branchCount`, the token sums and the cost all reach the sidebar. Three things
guard it, and the third was found by a test that failed:

1. **Byte-exact framing.** `foldFrom` splits on raw `0x0A` bytes and returns the
   offset just past the last complete line. It has to be exact, because it is
   where the next read begins, and a string-level split cannot report it: the
   byte length of a decoded line is unrecoverable once a multi-byte sequence has
   been split across chunks. Scanning bytes is safe for the same reason readline
   is not — no UTF-8 continuation byte can be `0x0A`. A trailing fragment with
   no newline is deliberately neither folded nor counted; it is a half-written
   record, and the next pass takes it whole.
2. **A tail signature.** The 64 bytes ending where the last parse stopped are
   re-read and compared before any resume. A rewrite that moves that boundary
   falls back to a full parse.
3. **New bytes are required.** The signature alone is not enough, and the test
   for a same-length rewrite is what showed it: rewriting a file's history while
   leaving its last 64 bytes intact matches the signature, and the resume would
   then answer with stale totals. `size > consumedBytes` sends that case to a
   full parse. It is a correctness condition, not an optimization.

`session-fold.test.ts` compares the incremental fold against the whole-file fold
directly rather than against hand-written expectations — across turn boundaries,
across offsets that split lines and multi-byte characters, and across a branch
whose parent was seen in an earlier pass. Plus truncation, same-length rewrite,
CRLF, and a half-written trailing record.

## Four smaller ones

- **A null meta is now cached.** A file with no `type: "session"` header parses
  to nothing, and that answer was never stored — so those files were fully
  re-parsed on **every** scan, not merely when they changed. MEASURED: 5 of 112
  real session files here have no header, and one is 3.2 MB, re-read in full on
  every sidebar refresh of that workspace, forever.
- **Both scanner caches are bounded.** `metaCache` was a plain `Map` that also
  kept entries for deleted files forever (perf-findings F17). It is now an LRU
  and drops entries whose file has left the directory. The resume cache is much
  smaller — 16 — because each entry holds a `seenParents` set that grows with
  the transcript (~400 KB for a 3.6 MB session), and only files being appended
  to can use one.
- **`realCwd` is memoized.** A blocking `realpathSync.native` ran on every
  session scan and every session-dir watch, for a set of workspaces that does
  not change while the app runs. Successful resolutions only: caching a miss
  would permanently mis-resolve a workspace created a moment later, which is
  exactly what a fresh worktree is.
- **`currentLeafId` reads a bounded tail.** It read and split the entire
  transcript to find the last entry's id, on every bookmark and branch jump.
  Now a 64 KB window, falling back to the full read when the window holds no
  complete record.

## Two payloads that crossed IPC to be discarded

`agent_end.messages` (every message of the run) and `turn_end.toolResults`
(every tool result of the turn) were structured-cloned to the renderer and then
thrown away: the reducer reads `agent_end.willRetry` and nothing else, and its
`turn_end` branch is `return state`. Everything in those arrays had already
arrived through the streaming events.

`electron/ipc/event-trim.ts` empties them at the push boundary. Three things
about the shape of that fix are deliberate:

- **The arrays are emptied, not removed, and no event is dropped.** Both fields
  are required by `shared/rpc.ts`, which is a hand-mirror of pi's protocol
  carrying compile-time drift guards. Narrowing it to make a field optional
  would weaken that guard for everyone.
- **It trims only what goes to the renderer.** The fleet hub subscribes to the
  client directly and still sees every event whole.
- **Other events are returned by identity**, so the per-token path allocates
  nothing.

## Verification

`npm run typecheck`, `npm run lint`, `prettier --check`, 1740 unit tests
(150 files) and all 34 e2e specs pass. The fd-counting and scan-timing
benchmarks were run against the real `~/.pi/agent/sessions` tree but are not
committed — they need real multi-megabyte transcripts.

## A note on the measurements

The first end-to-end benchmark reported **0.9×** — no win at all. Two faults:
it rewrote the whole file each turn, which swamped the parse in both arms, and
it compared the new scanner (readdir + stat + signature) against a bare
`parseSessionFile`. The second attempt reported a real win on one session and
none on another; instrumenting the resume path showed `incremental=0, full=52`
for the second, because that particular file has no session header and so was
never cacheable at all. Both numbers were wrong for reasons that had nothing to
do with the change. The tables above come from the third attempt, which appends
like pi does and compares a faithful reproduction of the old scanner against the
new one.
