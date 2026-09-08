# Worktrees

Phosphor sessions are tied to their cwd (pi records sessions under
`~/.pi/agent/sessions/<mangled-cwd>/`), so a git worktree is the natural unit
of parallel work: each task gets its own checkout, its own sessions, its own
sidebar group.

## Decisions

- **Location**: `<repo>/.phosphor/worktrees/<name>`, ignored via
  `.git/info/exclude` (appended idempotently; tracked files never touched).
  In-repo keeps worktrees discoverable and the sidebar group name meaningful
  (groups key on cwd basename).
- **A new chat gets its own branch, named after itself — but it is cut first
  and named second.** Sending the first message derives a branch and folder
  from a slug of that message, starts pi there immediately, and _then_ asks the
  naming model for a title; when it lands it sets the session name and renames
  the branch to match (`src/features/sessions/startChat.ts`). One name in three
  places still, a few seconds in.

  _This reverses the original order, in which naming blocked the send._ The
  reason was sound — a pi session is bound to the cwd it spawned in, so the
  worktree must exist first, and the branch was named after the title — but
  `pi -p` is a whole agent boot: ~6s before the model is asked anything, ~13s
  for a real naming prompt, against a 12s cap. The title lost its own race
  every time, so in practice every auto-created branch was already named after
  the message slug and the title arrived only via a second ~13s call. The send
  button blocked for 12s to achieve nothing. Inverting the dependency keeps the
  outcome and drops the wait.

  The worktree **folder** keeps its slug when the branch is renamed: it is a
  live session's cwd, and moving it would break that session's binding to its
  transcript. `git branch -m` is safe on a branch a worktree has checked out —
  git rewrites that worktree's HEAD.

  Every step still degrades rather than aborting — an unreachable remote falls
  back to local trunk, a git refusal to a plain session with the reason shown,
  a failed naming leaves the slug standing.

- **Auto-created branches start from `origin/<trunk>`, not local trunk.**
  "Branch off the latest main" is the intent, and a local `main` in a repo
  someone has been working in is routinely stale. Pulling it first would fail
  on a dirty main tree, so Phosphor fetches (throttled) and branches off the
  remote-tracking ref instead: freshest trunk, main checkout untouched, dirty
  or not. `--no-track` goes with it, or the new branch would take `origin/main`
  as its upstream and read as "behind trunk" forever
  (`startPoint` in `git-worktrees.ts`).
- **The branch prefix is configurable, and one flag governs isolation.**
  `phosphor/` by default (Settings → Workspaces, empty allowed). The composer's
  "new branch" checkbox, the branch popup's "worktree" checkbox and the
  settings toggle are one persisted preference — three surfaces asking "does
  my work get its own branch?" that must not be able to disagree. It persists
  now; before, it reset to on at every launch.
- **The main tree's checkout may be changed, but only deliberately and only
  when it is safe.** _This reverses the original rule that Phosphor would never
  run `git checkout` in the main tree._ The reversal was requested so the
  branch picker matches Claude Desktop, where unticking "worktree" means the
  branch opens in the checkout you already have. The safety the old rule
  provided now lives in guards instead: `checkoutBranch` refuses on any
  uncommitted change, and refuses when another worktree holds the branch
  (naming which one). The default is still isolation — the "worktree" checkbox
  starts ticked.
- **Nothing uncommitted is lost silently.** Dirty worktrees refuse removal
  until the user checks an explicit "discard N changes" box; branch deletion
  needs the branch's work to be on the trunk already — ancestry or squash merge
  (`isBranchMerged`); anything unproven survives with the reason shown; a dirty tree refuses checkout, pull, and update-from-main alike.
- **Merges are guided, not magic**: commit (user-typed message) → preflight
  (main tree clean; no auto-stash/checkout) → `git merge --no-ff`; conflicts
  abort immediately so the repo is never left mid-merge.
- **Pulling is fast-forward only.** `git:pull` runs `merge --ff-only`, so a
  one-click Pull can never write a merge commit or drop the user into a
  conflicted tree. Diverged branches are reported as diverged and sent to a
  manual merge. Bringing a worktree up to date with trunk
  (`git:updateFromMain`) _is_ a real merge, because a worktree with its own
  commits has diverged by definition — it aborts on conflict.
- **The remote is fetched, not assumed.** Ahead/behind used to be measured
  against whatever `refs/remotes/*` happened to be on disk, so a repo nobody
  had fetched reported "up to date" indefinitely. `git:fetch` runs
  `fetch --prune` on workspace open and on branch-menu open, throttled to once
  per 3 minutes per repo and deduped in flight. It never throws: offline, no
  remote, and no credentials are ordinary states.
- **realpath parity**: worktree paths are compared via `realpathSync.native`
  (`normalizeRealPath`), matching pi's cwd mangling in `pi-paths.ts`.

## Surfaces

There is **one** branch control visible at a time. It replaced three
overlapping ones — the home composer's chip, the chat header's git chip, and
the sidebar group menu — which could each answer "which branch will this run
on?" differently and none of which was visible from the others.

It lives in the window's top bar (`src/app/TopBar.tsx`) on session screens,
and directly above the composer on the home screen, alongside the folder chip
and the "new branch" checkbox. The top bar renders neither when no session is
active, so the two are never on screen together: choosing where a chat will
run is the _subject_ of the home screen rather than window furniture, and the
top bar's compact chips sit far from the composer and get clipped behind the
OS window controls. Same components, same state — one surface owns them per
screen, which is the invariant that matters.

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

Beside them sits the "new branch" checkbox, which answers a different question
("does this chat need a branch at all?") and is worth answering per message: a
quick question does not deserve one. Ticked (the default), a new chat branches
off trunk even when the open workspace is itself a worktree, because a new chat
means new work. Continuing on the branch you are looking at is the sidebar's
"New session here".

## Code map

- `src/features/sessions/startChat.ts` — the home composer's send path:
  bounded fetch, branch/folder derivation from the message slug, worktree
  creation, workspace switch, session spawn — then, off the critical path,
  naming and the branch rename. Every failure mode degrades to a running
  session.
- `src/lib/branchName.ts` — pure title → `{folder, branch}` derivation
  (slug, prefix normalization, collision suffixes). Its charset is narrower
  than git's ref rules on purpose, so no result needs re-validating.
- `electron/fs/git-worktrees.ts` — worktree lifecycle (execFile, no shell);
  `parseWorktreeList` is pure. `listBranches` enriches each branch with
  upstream tracking and distance from trunk in two `for-each-ref` calls —
  deliberately two, because `%(ahead-behind:)` is git 2.41+ and an unknown atom
  fails the whole command, which would cost older git the pull prompt as well.
- `electron/fs/git-sync.ts` — fetch (throttled), fast-forward pull,
  update-from-trunk, and main-tree checkout. Result unions, not throws, for
  expected refusals.
- IPC: `git:listWorktrees / listBranches / addWorktree / removeWorktree /
pruneWorktrees / commitAll / mergeBranch / fetch / pull / updateFromMain /
checkoutBranch` (`shared/ipc.ts`, `electron/ipc/git-handlers.ts`, mocks in
  `src/dev/mockPhosphor.ts`).
- `src/stores/worktrees.ts` — `byRepo[repoPath]` cache of worktrees/branches
  plus fetch bookkeeping, and the global `preferWorktree` checkbox state.
- UI: `src/features/worktrees/BranchControl.tsx` (top-bar chip + popup),
  `BranchPicker.tsx` (the shared body: search, checkbox, rows, actions),
  `RemoveWorktreeModal.tsx`, `MergeWorktreeModal.tsx`, `PrRow.tsx`;
  sidebar group context menu in `src/features/sessions/Sidebar.tsx`.
- Worktree detection for arbitrary cwds: `GitInfo.isWorktree/mainRepoPath`
  from `git rev-parse --absolute-git-dir --git-common-dir`
  (`electron/fs/git-info.ts`), also shown in sidebar row subtitles.

## Tests

- `electron/fs/git-worktrees.test.ts` and `git-sync.test.ts` run
  **real git** in mkdtemp repos; the sync suite clones a local "remote" so
  fetch/pull/ff-only refusal are exercised for real.
- `src/lib/branchName.test.ts` covers the derivation, including that no slug it
  can produce is a ref `git check-ref-format` would reject.
- `e2e/smoke.spec.ts` "worktree flow": git-init a scratch workspace → create
  `task-1` from the top-bar control → send a first message → the chat branches
  off trunk into `phosphor/stub-session-title` rather than continuing on `task-1`
  → one sidebar group for the project. Its sibling test unticks the composer
  checkbox and asserts nothing is created. The stub answers the naming prompt
  with a fixed title and honours `-n`, which is what makes the branch name
  deterministic; it still derives its session dir from `process.cwd()`.
