# 2026-08-30 — worktrees stop masquerading as workspaces on startup

For the first second or two of every cold start, the sidebar showed a header
per **git worktree**: `PR15889-WT`, `AUGMENT-SERVICES-KNOW719`,
`HALVOR-LINES-S3-INGRESS`, `BLISSFUL-HERMANN-8C6A0A`, a dozen more. Two real
workspaces were persisted. Every other header was a branch of one of them,
and every one of them vanished a moment later.

## The information was in hand and thrown away

`Sidebar.tsx` discovers worktrees by calling `git:listWorktrees` once per known
repo root. It stored the answer as `string[]` — the paths only. The root each
worktree came from was discarded on the line that collected it.

Grouping then had to re-derive that root, through `projectPathFor`, whose two
sources both fail in this window:

- `git.isWorktree` + `mainRepoPath` is authoritative, but arrives over
  `git:infoBatch` — debounced 300ms and then 2-3 git subprocesses per cwd,
  across every worktree plus every session cwd. On a machine with 25 worktrees
  that is a visible wait.
- The no-I/O fallback matches `<repo>/.phosphor/worktrees/<name>` only. None of
  the folders above are that shape: they are `.claude/worktrees/`,
  `augment-services-worktrees/`, sibling directories, and `/private/tmp`.

So each resolved to itself, became its own project group, and survived the
"keep unscanned groups" filter in `groupSessions.ts` because no session scan
had reached it yet. When git info landed they all collapsed into their repo.

## The fix

`projectPathFor` gains a third source, `knownRoot`, between git info and the
path shape. The sidebar keeps `{ path, root }` per discovered worktree and
passes the map into `groupSessionsByProject`. Grouping is correct on the render
that first learns the path — no round trip, because the discovery call already
answered the question.

Two smaller holes closed alongside it:

- **Worktrees that do not exist.** `git worktree list` keeps listing a folder
  after it is deleted, flagged `prunable`. One of those was a sidebar group for
  a directory that was gone. Discovery now skips them.
- **Recents that do not exist.** `getPrefs` filtered worktree folders out of
  `recentWorkspaces` but never checked the folder was still there. It does now,
  via `visibleWorkspaces` in `prefs-utils.ts`. Read-only, deliberately: a
  workspace on an unmounted volume is missing today and back tomorrow, and
  writing the prune back would lose the user's sidebar order for good.

## Why the skeleton is narrow

`WorkspaceGroupSkeletons` covers exactly one window: `collapsed === null`,
before `app:getPrefs` answers. Prefs decide both which workspaces exist and
what order they sit in, so a header painted before they land can be wrong or
about to jump.

It deliberately does **not** wait for worktree discovery. That pass is a
`git worktree list` plus a `git status` per worktree per root, and holding the
whole sidebar behind it would trade a one-second flash for a two-second blank.
With the root map in place there is nothing wrong to hide during that pass.
