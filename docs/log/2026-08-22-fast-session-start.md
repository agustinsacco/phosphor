# 2026-08-22 — A new chat starts now, and gets named after

Starting a chat from the home composer blocked for ~13 seconds, produced a
branch named after the raw first message rather than a title, and left the new
session's sidebar row inert to right-click. Three separate bugs in
[2026-08-22-session-branch-per-chat.md](2026-08-22-session-branch-per-chat.md),
plus the folder picker that had no home on the new-session screen.

## The naming call lost a race with itself

`startChat` awaited `pi:generateTitle` before it would create the branch,
capped at `TITLE_TIMEOUT_MS = 12_000`. Measured on the machine that reported
this:

| call                                                  | time       |
| ----------------------------------------------------- | ---------- |
| `pi -p --no-session --no-tools` with a trivial prompt | **6.2s**   |
| the same call with a real naming prompt               | **12.86s** |
| the cap it was racing                                 | 12.00s     |

12.86 > 12.00, so the title was `null` every single time. Which meant the
branch was derived from `title ?? prompt` — the message slug — and no `name`
reached `createSession`, so the store's own `autoNameSession` fired a **second**
~13s `pi -p`. Two model calls, ~26s, and a branch named
`phosphor/read-each-of-the-12-largest-tsx-files`. Both worktrees sitting in the
reporter's repo were slugs; the feature had never once produced a generated
name.

Git was not implicated and worth ruling out explicitly: `fetch --prune` was
0.61s and `worktree list` plus `status` across 11 worktrees was ~0ms.

The fix inverts the dependency rather than raising the cap. `pi -p` is a whole
agent boot — ~6s of it is fixed cost before the model is asked anything — so no
cap makes it fast enough to sit in front of a button. The branch is now cut
from the message slug immediately, pi spawns and starts inference, and the
title is generated off the critical path; when it arrives it sets the session
name and renames the branch to match.

`git branch -m` is safe on a branch a linked worktree has checked out — git
rewrites that worktree's HEAD, verified in `git-worktrees.test.ts`. The
worktree **folder** deliberately keeps its slug: it is a live session's cwd,
and pi binds a session to the cwd it spawned in, so moving it would sever the
session from its transcript.

The fetch that remains in front of the send is now bounded (`FETCH_BUDGET_MS`,
3s). It was unbounded behind a 30s main-process timeout, which put the whole
worst case back in front of the button the moment a remote was slow or wanted
credentials. It is not cancelled, only stopped being waited on.

## A watcher that was born dead

Right-click did nothing on a freshly created session until you switched away
and back. Not a lock — a missed refresh.

`watchWorkspaceSessions` called `chokidar.watch(sessionDirForCwd(path))`, and
for a brand-new worktree that directory does not exist yet: pi creates
`~/.pi/agent/sessions/--<mangled cwd>--` when it writes its first session file.
chokidar does not poll for a missing watch target. Pointed at one it reports
`getWatched() === {}` and never fires, **even once the path appears**:

```
watcher ready; watched: {}
creating dir + file now...
RESULT: add events fired = 0  => WATCHER IS DEAD
```

So no `sessions:changed` push ever arrived, the session never got a row in
`disk`, and it stayed a `PendingSessionRow` — which has no `onContextMenu` at
all, by design, because every `SessionRow` action is keyed on `meta.path`.
Switching sessions changed `useActiveWorkspace()`, which changed the
`knownWorkspaces` memo, which re-ran `refreshAllDisk` and materialised the row.
Hence the workaround.

Two fixes, because one is not enough. The watcher now `mkdir`s the directory
before watching it (pi creates the same path, so this is at worst a second
early). And `bootstrapSession` re-scans the folder when it learns the session's
`diskPath`, because `ignoreInitial: true` means a file already written by the
time the watcher attaches raises no event either — which is the normal case for
a worktree that only becomes watched once the session creating it exists.

`electron/pi/session-watcher.test.ts` is new and covers both; it was
confirmed to fail against the un-fixed watcher before being kept.

## One branch control per screen

The folder and branch chips were moved to the top bar in the top-bar refactor,
where on the home screen they sit far from the composer and get clipped behind
the OS window controls. They are now rendered above the composer on the home
screen — and the top bar renders neither when no session is active, so there is
still exactly one of each on screen. Rendering both would have recreated the
"two answers to one question" problem the top bar was built to solve, and did
briefly: two `workspace-chip` testids broke the e2e suite on strict-mode
violations, which is how it was caught.

## Two bugs found on the way

- **`BranchControl` never re-read after a git mutation.** It holds its own
  `git:info` state, refreshed on mount and on `fs:watchWorkspace` events — and
  `git branch -m`, `checkout`, worktree add/remove all write inside `.git`,
  which that watcher does not report. The chip kept naming a branch that no
  longer existed. It now also re-reads when the worktrees store's repo slice
  changes, which covers every mutation that store performs.
- **The pi stub invented a session name.** Without `-n` it reported
  `'E2E stub session'` from `get_state`, but real pi never titles a session by
  itself. Every Phosphor auto-naming path is guarded on "has pi already got a name
  for this?", so the stub silently disabled the very thing it was added to
  test. It now reports no name unless `-n` is passed.

## Tests

- `git-worktrees.test.ts` — rename under a live worktree (and that the worktree
  HEAD follows), refusal on a taken target, refusal of ref-hostile names,
  same-name no-op.
- `session-watcher.test.ts` (new) — the dir is created before watching, and a
  file written afterwards produces a `sessions:changed` push. Both fail without
  the fix.
- `e2e/smoke.spec.ts` — the worktree flow now asserts the new order: the folder
  is `update-hello-ts` (the message slug, cut before naming), the branch ends
  as `phosphor/stub-session-title` after the rename, and `phosphor/update-hello-ts` is
  **gone** — renamed, not duplicated.

Full suite green at the time of writing.

> **Follow-up, 2026-08-23** — two claims in this section did not survive review
> and are corrected in
> [2026-08-23-e2e-isolation-and-the-missing-regression-test.md](2026-08-23-e2e-isolation-and-the-missing-regression-test.md):
> the run-wide e2e failure blamed on "intermittents" was a real, reproducible
> shared-state bug, and the right-click fix above shipped with **no test that
> reproduced it** — the e2e stub wrote its session file synchronously, which
> made the bug unreachable from the suite. Both are now fixed. Test counts are
> deliberately no longer quoted here; they age into being wrong within days.
