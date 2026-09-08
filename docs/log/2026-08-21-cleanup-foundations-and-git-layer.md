# Cleanup, part 1: foundations and the main-process git layer

2026-08-21. Phases 1 and 2 of `specs/backlog/cleanup-plan.md`.

## What this was

A full read of `src/`, `electron/`, `shared/` and `pi-ext/` turned up very
little structural rot and a great deal of horizontal duplication — the same
shape re-implemented four to nine times because each copy arrived with a
different feature. The plan splits the fix into phases that land independently.
This is the first two, plus one bug found on the way.

## Dead code

`src/features/chat/blocks/ThinkingBlock.tsx` had no importers. Thinking is
rendered by `items/ActivityGroup.tsx` now, as hover-revealed thought rows,
which is a different design from this file's collapsible disclosure. It was the
only file in `blocks/`, so the directory went with it.

`isMonitorWindowOpen()` and `isSampling()` had zero callers. The second is
documented as a "test seam" for `electron/resources/monitor.ts`, which has no
test file at all — the seam was built and never used.

`Sidebar.tsx` re-exported `lib/time`'s `relativeTimeShort` under the name
`relativeTime`. That is a _different_ function in that same module, with a
different output format, so the alias was actively misleading; and it made a
component file the barrel through which `ArtifactsPane` reached for a
formatter. ArtifactsPane imports `relativeTimeShort` from `@/lib/time` now.

## `shared/errors.ts`

26 sites hand-rolled the conversion from `unknown` to a message. Thirteen used
`err instanceof Error ? err.message : String(err)`; the other thirteen used
`(error as Error).message`, which is a cast rather than a check. That second
form is wrong in a way that matters here: `Error` prototypes do not survive the
context bridge, so an IPC rejection arrives as a plain object, and reading
`.message` off a non-Error means the error _handler_ throws its own error while
reporting the first one. `errorText()` narrows properly and handles the
object-with-message shape IPC actually produces.

It lives in `shared/` rather than as one copy per side because both sides need
it and two copies would drift — which is the failure mode this whole exercise
is about. `shared/` already carries runtime code consumed by main
(`clampUiScale`, `MIN_PI_VERSION`) and by the renderer
(`supportedThinkingLevels`), so this is not a new precedent.

## `preload.ts`

Nine subscription methods were the same four lines with a different channel and
payload type. One `subscribe()` helper; nine one-liners. `PhosphorApi` is
unchanged, so neither the renderer nor `mockPhosphor.ts` can tell.

## `electron/fs/git-exec.ts`

Four files each declared a private `git(cwd, args)` around
`promisify(execFile)`, and the limits had drifted to four different values with
nothing recording why: 10s/1MB, 20s/64MB, 30s/16MB, 30s/16MB. The 1MB default
was the one that mattered — `git status --porcelain` on a very large dirty tree
overflows it, and the caller's `catch` swallows that as "no dirty count". One
documented pair of limits (the widest of the four) applies everywhere now, with
`allowFail` and `trim` as explicit options rather than per-copy behavior.

`dirtyCount` had four implementations that disagreed on trailing newlines. This
is the one place behavior was deliberately unified rather than preserved, so it
carries a test covering clean, one-file and three-file trees.

`heldBy()` in `git-sync.ts` hand-parsed `git worktree list --porcelain` a
second time; it sits on the already-tested `parseWorktreeList()` now. The
merge-conflict abort block that `mergeBranch` and `updateFromMain` both carried
is one `abortMergeAndCollectConflicts()`.

## `electron/pi/json-config.ts`

Three implementations of "read a JSON config, tolerate a missing file, report a
malformed one" — in `agent-settings.ts`, `mcp-config.ts` and `packages.ts`,
the last of them synchronous and silently conflating missing with malformed.
One `readJsonFile()` now. `listPackages` became async as a result;
`shared/ipc.ts` did not change, because that channel already returned a Promise.

## The bug

`git-info.ts` set `info.behind = behind ?? 0` after a `parseInt`. `??` does not
catch `NaN`, so malformed `rev-list` output crossed IPC and rendered as "NaN
behind" in the branch UI. `git-sync.ts`'s equivalent always used `|| 0`. Found
while consolidating the runners, not introduced by it.

## Also in this commit

`specs/backlog/perf-findings.md` — a separate read-only audit of memory and CPU on the
RPC and streaming path. It is analysis only; nothing in it is implemented here.
Three of its findings are bugs rather than slowness, and two of them are cases
where a comment in this repo describes a fix that is not actually wired up.
Read its ALREADY FINE section before re-investigating anything on that path.

## Verification

`npm run validate` green; `npm run test:e2e` 22/22.
