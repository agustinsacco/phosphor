# EMFILE at session start: the watcher bound the wrong quantity

2026-08-31

## Why

Starting a session — on app launch, or the first session in a workspace —
sometimes failed with:

```
Couldn't start this session. Error invoking remote method 'pi:createSession':
Error: EMFILE: too many open files, open
'/Users/agustinsacco/Library/Application Support/Phosphor/config.json'
```

`config.json` is a red herring. It is `electron-store`'s file, opened on the
first `getPrefs()` of the call, and it is simply whatever happened to want a
file descriptor after the process had already run out. Any `open()` in the
main process would have failed the same way.

## What was actually true

MEASURED on the live main process (pid 86679) while the error was reproducing:

```
lsof -p 86679 | wc -l                    → 92 220
sysctl kern.maxfilesperproc              → 92 160
```

The process was pinned at the macOS per-process ceiling. (The `launchctl limit
maxfiles` soft limit is 256, but Electron raises its own `RLIMIT_NOFILE` at
startup, so `kern.maxfilesperproc` is the real wall.)

Grouping those descriptors by directory found a single culprit:

```
91 255  …/augment-local/.overrides-local/workflow-retries/captures
    41  …/augment-local/evidence/service-profile-matrix
    27  …/augment-local/src/service-profiler/probes
```

That one directory holds **133 518 JSON files** in 1.0 GB, flat. The workspace
watcher had opened 91 255 of them and was refused the rest.

## The bound that was not a bound

`workspace-watcher.ts` already carried an EMFILE fix, from the augment-services
monorepo freeze: `IGNORED_DIRS` plus `MAX_WATCH_DEPTH = 3`. Its comment said

> Chokidar opens one file descriptor PER DIRECTORY

That sentence is wrong, and the wrongness is the whole bug. chokidar opens one
fd per watched **path**. `_handleFile` → `_watchWithNodeFs` → `fs.watch(file)`,
and on macOS libuv backs each `fs.watch` with an `open(path, O_EVTONLY)` — which
is why all 91 255 showed up in `lsof` as `REG`, not `KQUEUE`.

Reproduced in isolation, with the pre-fix options (3 000 files at depth 3):

```
watched dirs      : 5
watched entries   : 3005
fds before/after  : 21 / 3022  delta = 3001
```

Five directories, three thousand descriptors.

So the depth cap could not help. `depth` gates directory _recursion_ only —
`handler.js:543`, `depth <= oDepth` — and `_handleFile` has no depth check at
all. `captures` sits at exactly depth 3, which is legal, so chokidar read it and
gave every one of its 133 518 files its own descriptor. A flat directory defeats
a depth cap by construction: every file in it is at the same legal depth. Both
existing bounds counted directories; nothing counted files.

## The fix

Two new bounds in `workspace-watcher.ts`, both on the axis that actually costs
descriptors, expressed as a stateful `ignored` predicate (`createWatchFilter`):

- **`MAX_DIR_ENTRIES = 2 000`** — a directory holding more entries than this is
  skipped whole. Probed with `opendirSync` + a bounded `readSync` loop that
  stops the moment it knows, so probing a million-file directory costs the same
  as probing a two-thousand-file one, and cached per path. A directory with
  > 2 000 files directly in it is generated data, not source.
- **`MAX_WATCHED_PATHS = 12 000`** — a hard ceiling per workspace. The prune
  list and the depth cap are heuristics an odd repo walks straight past; this is
  the only true bound. Slots are returned on `unlink`/`unlinkDir`, or a long
  session in a churning repo would drain the budget and silently stop watching.

Only calls carrying `stats` may spend budget. chokidar asks about each path
twice — once from readdirp with stats, once without (`handler.js:569`) — so
recording on the stats-free call would both double-count and skip the directory
probe. A path already granted a slot always answers "not ignored", so repeated
questions are idempotent and the budget filling up can never read as a deletion.

MEASURED on the workspace that caused this, `augment-local`:

|               | before          | after  |
| ------------- | --------------- | ------ |
| fds           | 91 255 (EMFILE) | 811    |
| watched dirs  | —               | 421    |
| time to ready | never           | 348 ms |

`captures` is now skipped with one log line naming it.

## Also fixed: the prune list matched absolute paths

Found while building the fixture, which lived under `/private/tmp/…` and was
watched as nothing at all. `IGNORED_DIR_PATTERN` was tested against the
**absolute** path, so a workspace anywhere beneath a directory named `tmp`,
`build`, `out`, `dist`, `vendor` or `temp` had every file it owns pruned —
`/Users/me/build/myapp` got a watcher bound to nothing, with no error and no
log line. The pattern is now matched against the path relative to the workspace
root. The root itself is never prunable, for the same reason.

## Guard

`electron/fs/workspace-watcher.test.ts` pins both new constants and the
predicate's behaviour: dump directories skipped whole, the budget ceiling,
idempotence across the stats/stats-free call pair, slot release on delete, and
the relative-path scoping. The fd-counting integration proof was run against the
real repo but not committed — it needs `lsof` and a 133 k-file fixture.

## Not changed at the time — since done

`electron/pi/session-watcher.ts` has the same per-file cost at `depth: 0`; the
session directories it watches topped out at 10 files here, so it was left
alone in this change. A budget landed the next day with the session resource
work — see
[2026-09-01-session-reaper-and-live-stats.md](2026-09-01-session-reaper-and-live-stats.md).
