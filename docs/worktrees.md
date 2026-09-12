# Worktrees

A pi session is bound to its cwd (pi records sessions under
`~/.pi/agent/sessions/<mangled-cwd>/`), so a git worktree is the natural unit of
parallel work: each task gets its own checkout, its own sessions, its own
sidebar group. Several agents on several branches, none of them stepping on
your main checkout.

## Decisions

- **Location**: `<repo>/.phosphor/worktrees/<name>`, ignored via
  `.git/info/exclude` (appended idempotently; tracked files never touched).
  In-repo keeps worktrees discoverable and the sidebar group name meaningful.
- **A new chat gets its own branch, named after itself. It is cut first and
  named second.** Sending the first message derives a branch and folder from a
  slug of the message, starts pi there at once, and _then_ asks the naming
  model for a title. When the title lands it renames the session and the
  branch to match (`src/features/sessions/startChat.ts`). One name in three
  places, a few seconds in, and the send button never waits for a model.

  The worktree **folder** keeps its slug when the branch is renamed: it is a
  live session's cwd, and moving it would break the session's binding to its
  transcript. `git branch -m` is safe on a checked-out branch; git rewrites the
  worktree's HEAD.

  Every step degrades rather than aborting: an unreachable remote falls back
  to local trunk, a git refusal to a plain session with the reason shown, a
  failed naming leaves the slug standing.

- **Auto-created branches start from `origin/<trunk>`, not local trunk.**
  "Branch off the latest main" is the intent, and a local `main` in a repo
  someone has been working in is routinely stale. Pulling first would fail on
  a dirty main tree, so Phosphor fetches (throttled) and branches off the
  remote-tracking ref: freshest trunk, main checkout untouched. `--no-track`
  goes with it, or the branch would read as "behind trunk" forever.
- **The branch prefix is configurable, and one flag governs isolation.**
  `phosphor/` by default (Settings → Workspaces, empty allowed). The composer's
  "new branch" checkbox, the branch popup's "worktree" checkbox and the
  settings toggle are one persisted preference, so three surfaces asking "does
  my work get its own branch?" cannot disagree.
- **The main tree's checkout may be changed, but only deliberately and only
  when safe.** Unticking "worktree" opens the branch in the checkout you
  already have, as in Claude Desktop. `checkoutBranch` refuses on any
  uncommitted change and refuses when another worktree holds the branch,
  naming which one. The default is still isolation.
- **Nothing uncommitted is lost silently.** A dirty worktree refuses removal
  until you tick an explicit "discard N changes" box. A branch is deleted only
  when its work is proven on the trunk, by ancestry or by squash-merge test
  (`isBranchMerged`); anything unproven survives with the reason shown. A
  dirty tree refuses checkout, pull and update-from-main alike.
- **Merges are guided, not magic**: commit (your message) → preflight (main
  tree clean; no auto-stash, no auto-checkout) → `git merge --no-ff`. A
  conflict aborts immediately, so the repo is never left mid-merge.
- **Pulling is fast-forward only.** One-click Pull can never write a merge
  commit or drop you into a conflicted tree; a diverged branch is reported and
  sent to a manual merge. Bringing a worktree up to date with trunk
  (`git:updateFromMain`) _is_ a real merge, because a worktree with commits has
  diverged by definition. It aborts on conflict.
- **The remote is fetched, not assumed.** `git:fetch` runs `fetch --prune` on
  workspace open and on branch-menu open, throttled to once per 3 minutes per
  repo. It never throws: offline, no remote and no credentials are ordinary
  states.
- **realpath parity**: worktree paths are compared via `realpathSync.native`,
  matching pi's cwd mangling in `pi-paths.ts`.

## Surfaces

There is **one** branch control visible at a time. It lives in the window's
top bar (`src/app/TopBar.tsx`) on session screens, and directly above the
composer on the home screen beside the folder chip and the "new branch"
checkbox. The top bar renders neither when no session is active, so the two are
never on screen together. Same components, same state; one surface owns them
per screen.

| Operation                                         | Top-bar branch control      | Sidebar group menu     |
| ------------------------------------------------- | --------------------------- | ---------------------- |
| Search all branches                               | ✓                           |                        |
| Switch workspace (main / worktree)                | ✓                           |                        |
| Open a branch as a worktree                       | ✓ (checkbox ticked)         |                        |
| Check a branch out in the main tree               | ✓ (checkbox unticked)       |                        |
| Create worktree (new branch, chosen base)         | ✓                           |                        |
| Pull trunk when behind the remote                 | ✓ (row appears when behind) |                        |
| Update a worktree from trunk                      | ✓ (row appears when behind) |                        |
| Remove worktree (dirty guard, force, `-d` branch) | ✓ (row ✕)                   | ✓                      |
| Merge branch into main (guided)                   | ✓ (worktree sessions)       | ✓                      |
| Prune stale worktrees                             | ✓ (when any prunable)       |                        |
| New session in worktree                           | ✓ (switch, then compose)    | ✓ ("New session here") |

The "new branch" checkbox answers a different question ("does this chat need a
branch at all?") and is worth answering per message: a quick question does not
deserve one. Ticked (the default), a new chat branches off trunk even when the
open workspace is itself a worktree, because a new chat means new work.
Continuing on the branch you are looking at is the sidebar's "New session
here".

## Code map

- `src/features/sessions/startChat.ts` — the home composer's send path:
  bounded fetch, branch/folder derivation, worktree creation, workspace
  switch, session spawn; then, off the critical path, naming and the rename.
- `src/lib/branchName.ts` — pure title → `{folder, branch}` derivation. Its
  charset is narrower than git's ref rules on purpose, so no result needs
  re-validating.
- `electron/fs/git-worktrees.ts` — worktree lifecycle (execFile, no shell).
  `listBranches` uses two `for-each-ref` calls because `%(ahead-behind:)` is
  git 2.41+ and an unknown atom fails the whole command.
- `electron/fs/git-sync.ts` — fetch, fast-forward pull, update-from-trunk,
  main-tree checkout. Result unions, not throws, for expected refusals.
- IPC: `git:listWorktrees / listBranches / addWorktree / removeWorktree /
pruneWorktrees / commitAll / mergeBranch / fetch / pull / updateFromMain /
checkoutBranch` (`shared/ipc.ts`, `electron/ipc/git-handlers.ts`).
- `src/stores/worktrees.ts` — per-repo cache of worktrees and branches, plus
  the global `preferWorktree` checkbox state.
- UI: `src/features/worktrees/BranchControl.tsx`, `BranchPicker.tsx`,
  `RemoveWorktreeModal.tsx`, `MergeWorktreeModal.tsx`, `PrRow.tsx`; the sidebar
  group menu in `src/features/sessions/Sidebar.tsx`.
- Worktree detection for any cwd: `GitInfo.isWorktree/mainRepoPath` from
  `git rev-parse --absolute-git-dir --git-common-dir`
  (`electron/fs/git-info.ts`).
