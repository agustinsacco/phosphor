# 2026-08-10 — Worktrees never take the default branch

Found the hard way: `git checkout main` in the main clone started failing with
`fatal: 'main' is already used by worktree at .../.phosphor/worktrees/main`. Phosphor
had offered `main` under "Branches (opens as worktree)" and created a worktree
for it, permanently locking the main tree out of its own default branch.

The subtle part is why the existing guards missed it. `addWorktree` already
refuses a branch that is checked out somewhere, and the menu already filtered
`isCurrent` branches — but git only reserves a branch while it is checked out
**right now**. From a feature branch, trunk is genuinely free, so both the menu
and git itself were happy to move it into a worktree. The invariant nobody
encoded: a worktree is for work happening _beside_ trunk, never instead of it.

- `addWorktree` now rejects `kind: 'existing'` when the branch is the repo's
  `defaultBranch`, with a message that says where trunk belongs and what to do
  instead. The check is in the main process, so it holds regardless of caller.
  Ordering matters: the already-checked-out check runs first, so the common case
  still gets the more specific "already checked out in …" message.
- `WorktreeMenu` excludes `defaultBranch` from the offered branches, and the
  trunk row is relabelled "Main tree — <branch>" (with a tooltip) since it is
  now the only route back to trunk.
- The create form caught a second papercut: typing an existing branch name
  surfaced git's raw `a branch named 'x' already exists`. It now pre-checks
  against the branch list and says whether to pick the existing worktree or
  choose a new name. Placeholder is "new branch name" (it creates a branch, which
  the old "worktree / branch name" obscured), and the base selector lists
  `base: <default> (default)` first instead of the opaque "current HEAD".

`kind: 'new'` needed no guard — `git worktree add -b` already refuses an
existing branch name, verified by probe rather than assumed.

Coverage: a real-git test that checks out a feature branch first, proving trunk
is refused precisely when git would have allowed it, plus that other existing
branches still work from there. The e2e placeholder selector moved with the
rename. `mockPhosphor` now reports `main` as **not** current (with a fourth branch
added), because the old fixture had `isCurrent: true` — the one state in which
this bug is invisible.
