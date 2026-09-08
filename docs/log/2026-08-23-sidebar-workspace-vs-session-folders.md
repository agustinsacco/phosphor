# 2026-08-23 — Sidebar shows sessions where workspaces belong

A session folder is not a workspace. Phosphor's session isolation gives every
chat its own git worktree under `<repo>/.phosphor/worktrees/<slug>`, and worktrees
are branches of a workspace, not workspaces themselves. But worktree folders
were being recorded as if they were workspaces, so the sidebar's chat list
(the workspace groups + the top workspace switcher) read as a pile of sessions
instead of the user's projects.

## The failure

`recentWorkspaces` is the sidebar's source of "known workspaces" and the
switcher lists it verbatim. It was filling with a worktree folder per chat:

- `startChat` calls `openWorkspace(worktreeCwd)` to point the top bar/file
  tree at the session's own checkout — but `openWorkspace` appended the path
  to `recents`, and `recordWorkspace` persisted it.
- Every `activate()` also `recordWorkspace(live.workspacePath)` — again the
  worktree.
- `getPrefs` returned them as-is, so hydrate loaded them.

In the real prefs the list was 14 folders, 11 of them per-chat worktree nodes
and only 3 real workspaces (`Phosphor`, `games`, `brigades`). The sidebar
_does_ recover by grouping worktrees under their main repo (`git:info`
supplies `isWorktree`+`mainRepoPath`, `groupSessionsByProject` merges on it) —
but only once git info has been fetched. Before that (and in the switcher,
which lists recents directly) you get a header per chat. A 11-of-14 rate of
session folders is how the list "reads as sessions."

## The fix

Treat a worktree folder as **not a workspace**: never persist it in
`recentWorkspaces`, and never add it to the renderer's `recents`. Its path
still becomes the active/current folder so the top bar, file tree and launch
resume behave exactly as before — only the persistent workspace list stays
clean.

- `src/lib/path.ts` — `isWorktreeFolder(path)`, a structural test for the
  `/.phosphor/worktrees/<name>` container (mirrored in `electron/store.ts`).
- `src/stores/workspaces.ts` — `openWorkspace` sets `homePath` always but only
  appends to `recents` for a non-worktree folder.
- `electron/store.ts` — `recordWorkspace` still writes `lastWorkspacePath`
  (resume is unaffected) but only records non-worktrees into
  `recentWorkspaces`; `getPrefs` prunes any already-polluted entries on read
  (so an existing install repairs itself on next launch).
- `src/features/sessions/Sidebar.tsx` — because worktrees are no longer
  persisted, the sidebar discovers each known repo's `.phosphor/worktrees/*` via
  `git:listWorktrees` (once per set of open roots) so their sessions still
  appear, folded into the project group they belong to.

Now the sidebar group list and the switcher show `Phosphor`, `games`, `brigades`
— the workspaces — with each project's worktree sessions under it, the way
`groupSessionsByProject` already intended.

Coverage: `isWorktreeFolder` cases in `path.test.ts`; a store test that
opening a worktree changes `homePath`/persists `lastWorkspacePath` but not
`recents`. Full unit suite, typecheck and lint green.
