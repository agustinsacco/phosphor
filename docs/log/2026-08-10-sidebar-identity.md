# 2026-08-10 — Sidebar identity: worktree names and pending session rows

Two sidebar bugs found in daily use, both about the sidebar disagreeing with
reality.

- **A worktree read as the wrong project.** `workspaceName()` is a basename
  function, and worktree folders are conventionally named after their branch
  (`.phosphor/worktrees/main`), so opening one showed "main" for what is actually
  the `Phosphor` repo — in the sidebar group header, the workspace switcher, the
  pinned-row workspace badge, and the window title. New `worktreeAwareName()`
  in `lib/path.ts` returns `repoName (branch)` when `GitInfo.isWorktree` and
  `mainRepoPath` are set, falling back to the plain basename otherwise (a
  workspace need not be a repo at all). The data was already on hand: the
  sidebar's `gitByCwd`/`git:infoBatch` cache carries `isWorktree`,
  `mainRepoPath` and `branch` — the call sites just weren't reading it.
- **A session you just started showed no row until its first tool call.**
  `createSession` optimistically populates `live` but never `disk`, and sidebar
  rows are sourced exclusively from `disk[workspacePath]`. So the row could not
  appear until pi wrote the session file's header AND chokidar's
  `awaitWriteFinish` (250ms) plus the watcher's own 300ms debounce elapsed AND
  `sessions:changed` triggered a re-scan — which in practice lands around the
  first tool call, so sending a message read as dropping it. `Sidebar` now
  derives `pendingByWorkspace` from `live` entries with no `diskPath` and
  renders a `PendingSessionRow` for each; they disappear on their own once
  `get_state` supplies the path and the real disk row takes over.

  Deliberately **not** a synthetic `SessionMeta` pushed into `disk`, and
  deliberately not a reused `SessionRow`: every action on that row is keyed on
  `meta.path` (rename, fork, clone, export, delete, open-from-disk), which a
  pending session does not have yet. A fake meta would also need reconciling
  against the real scan to avoid a duplicate or stale row. The placeholder only
  claims what it can back up — the session exists, it is starting, clicking it
  activates it.

Coverage: 5 unit tests for `worktreeAwareName` (including the folder-named-after
-its-branch regression). The pending row is DOM state over store selectors, so
it was verified in the mock harness instead — whose `get_state` returns no
`sessionFile`, making it a permanent pending row and a good fixture. `mockPhosphor`
gained a `mainRepoPath` on its worktree cwd so the harness exercises the
`repo (branch)` label at all.
