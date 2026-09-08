# Lane delete: squash-merged branches, and a modal that stopped growing

2026-09-01

Two faults in the same flow: every merged lane reported a branch error, and
the progress modal grew a row at a time while it ran.

## `git branch -d` refuses every merged Phosphor lane

`removeWorktree` deleted a branch with `-d` only, on the stated principle that
an unmerged branch must never be lost. The principle is right; the test was
wrong. `-d` asks "is this branch an ancestor of its upstream", and a squash
merge rewrites the branch into one new commit with no ancestry link back to
it. Phosphor lands PRs as squash merges, so `-d` refused **every** merged lane:

```
error: the branch 'agustin/lane-status-strip-leak' is not fully merged
```

The lane was deleted, the branch stayed, and the modal showed an error on a
delete that had in fact done everything asked of it. Ten lanes meant ten
errors.

`isBranchMerged` in `electron/fs/git-worktrees.ts` adds the squash test: build
a commit holding the branch's tree on top of the merge base, then ask
`git cherry` whether an equivalent patch is already upstream. Both
`origin/<trunk>` and local `<trunk>` are checked, because the squash commit
reaches the remote when the PR merges and local trunk only after a pull. The
synthesised commit is dangling; gc collects it.

`-D` now runs **only** when that test returns true. Anything unexpected
answers false, so a git failure can never read as proof that the work is safe.
A genuinely unmerged branch is still kept and reported, exactly as before.

## The error said "Command failed"

`execFile` rejects with `Command failed: git branch -d x\n<stderr>`, and the
modal's one-line slot truncates at 14rem — so the user was shown the command
back, not the reason. `gitErrorText` in `electron/fs/git-exec.ts` prefers
git's own `error:`/`fatal:` line and drops the `hint:` lines, which are advice
for a terminal user.

## The modal grew as it worked

`BulkDeleteProgressModal` rendered finished rows only. The panel therefore
gained a row every time a lane completed, drifting downward for the whole run
while the progress bar slid with it, and the bar had no padding under it until
the first row appeared.

`BulkDeleteProgress` now publishes the full lane list on the first frame. Rows
are rendered up front, dimmed, and fill in place (`·` pending, `…` current,
`✓`/`✕` done). The panel is at its final height before the first lane is
touched, and the run reads as a checklist rather than as a list being built.
