# Reclaiming dead lanes

2026-09-07

Nothing ever freed a lane's disk. Creating a lane is one click and each one is
a full worktree with its own `node_modules`, so the cost only accumulated:
**9.1 GB across 70 worktrees** on the machine this was measured on, roughly
77% of it duplicated dependencies. The only escape was selecting lanes in the
sidebar and deleting them by hand.

There is now a periodic sweep, in Settings → Advanced → Maintenance.

## Measuring and deleting are separate switches

A sweep **always** measures and **never** deletes unless
`reclaimMergedWorktrees` is on, and that ships off. Rebuilding a reclaimed lane
costs a fresh `npm install`, so the decision is the user's. The default is a
report: "N of M worktrees reclaimable, X GB on disk".

**Reclaim now** is the explicit path. It acts without flipping the pref, but
runs the same policy, so the button can never delete something a sweep would
have held.

## The policy is pure, and it is the part that is tested

`electron/maintenance/policy.ts` takes facts and returns candidates plus
**holds with reasons**. It does no git and no disk. Deciding what to delete is
where being wrong is unrecoverable, so it is the part that had to be
exhaustively testable, and the reason on every rejection is what makes a sweep
auditable after the fact.

Six conditions must all hold: not the main checkout, on a branch (a detached
worktree cannot be proven merged), clean, not a live session's cwd or an open
workspace, proven merged, and untouched for `minAgeHours` (24 by default).

They are deliberately redundant. `merged` alone would be enough in theory, but
a lane holding uncommitted work that happens to sit on a merged branch is
exactly the case where a wrong answer destroys someone's work.

"Proven merged" is `isBranchMerged`, the same squash test the manual bulk
delete uses: pidex lands PRs as squash merges, which leave no ancestry, so
`git merge-base --is-ancestor` answers no for every landed lane. Anything the
test cannot prove reads as **not** merged — an error must never read as proof.
Deletion still goes through `removeWorktree`, which refuses a dirty tree
itself and only escalates to `git branch -D` on a branch it can prove landed.

## What the grace period is for

A branch can land while its lane is still open in front of you. `lastWrite`
takes the newest mtime of the worktree **and** pi's session directory for that
cwd: a lane you read but never edit leaves the directory untouched while its
transcript keeps moving, and reclaiming a lane someone is still reading is the
failure this guards.

## Two smaller decisions

**Sizes come from `du -sk`, not an `fs` walk.** A lane's `node_modules` holds
six figures of files and walking 45 of them is felt. Windows has no `du`, so
the size reports `null`, the UI says "unknown", and the policy never depends on
the number.

**The scheduler is a plain unref'd interval in main.** The last thing that
reclaimed anything automatically was the session reaper, which derived its
schedule from the fleet hub and went out with it
([2026-09-03-remove-orchestration.md](2026-09-03-remove-orchestration.md)).
A timer owns no session state, so nothing here can hold a session open or read
a stale phase. It warms up for 5 minutes (launch is the busiest minute pidex
has), floors the interval at 15 minutes whatever the pref says, and runs one
sweep at a time — a `du` over a large workspace can outlast the interval, and
two concurrent sweeps would race on `git worktree remove`.

It sweeps only the **recent-workspaces** list, which `getPrefs` has already
stripped of worktree folders. Sweeping from inside a worktree would let a sweep
reclaim the directory it is running in.

## Not done

- The scan is unbounded fan-out: one `du` per worktree, all at once, on every
  Settings open. Fine at 70 worktrees on an SSD, and it is off the UI thread,
  but it is not a cap.
- Nothing reclaims a live pi subprocess yet (~200 MB each). That is F7 in
  [specs/backlog/perf-findings.md](../specs/backlog/perf-findings.md) and needs
  an activity tracker, not a timer.
