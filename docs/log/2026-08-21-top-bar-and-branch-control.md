# 2026-08-21 — One top bar, one branch control

Two problems that turned out to share a shape: state that belonged to the
window was being kept per-column, so whichever column happened to be in the
right place disagreed with the others.

## The pane buttons under the window controls

On Windows and Linux Phosphor runs frameless with a Window Controls Overlay
(`titleBarStyle: 'hidden'` + `titleBarOverlay`), so the OS paints
minimize/maximize/close over the top-right of the _page_. Exactly one element
compensated: the chat header, via `.titlebar-inset-end`.

That held only while the chat header spanned the window. Open a right-hand
pane and the pane owns the top-right corner — `PaneShell` renders its own
`h-11` header with ↗ expand and ✕ close at the far right, with no inset — so
those buttons rendered underneath the real window controls. The chat header's
inset padding meanwhile became dead space in the middle of the window.

Fixed structurally rather than by adding a second inset: one full-width
`TopBar` above every column, owning the inset once. `.titlebar-inset-end` is
`100vw`-relative arithmetic, so it is only ever correct on an element that
spans the window; making that a single element means no future pane can
reintroduce the bug. `.titlebar-inset-start` was repurposed from a 44px
vertical spacer in the sidebar (macOS traffic lights) to a horizontal lead-in
on the same bar.

The chat header, the home screen's drag strip, and the sidebar's drag strip
were all absorbed into it. `e2e/smoke.spec.ts` now asserts the pane's close
button starts at or below the title bar's bottom edge.

## Three branch controls became one

The home composer had a branch/worktree chip that chose where the _next_
session would start; the chat header had a separate git chip that switched
workspace; the sidebar group menu had a third subset. They could disagree, and
none was visible from the others' screen.

Now: one `BranchControl` in the top bar, with `BranchPicker` as its body.
Shape follows Claude Desktop — search over every branch, and a "worktree"
checkbox deciding whether a pick gets its own checkout. The old menu capped
the list at 8 with no search, so on any repo with real branch history the
branch you wanted often simply was not there.

`WorkspaceHome` no longer keeps a start target; a session starts in whatever
workspace is open. `GitChips`, `WorktreeMenu`, and `BranchWorktreeChip` are
gone; `WorkspaceChip` was lifted out of `WorkspaceHome` into
`src/features/workspaces/` so the bar hosts a real control rather than a label.

## Reversed: the main tree's checkout

`WORKTREES.md` used to state that Phosphor never changes the main tree's
checkout. Unticking "worktree" does exactly that, so the rule is now recorded
as reversed rather than quietly violated. The safety moved into guards:
`checkoutBranch` refuses on any uncommitted change and refuses when another
worktree holds the branch, naming which one. The checkbox defaults to ticked.

## Pull latest, and the fetch that makes it true

Nothing in Phosphor ran `git fetch`, so `GitInfo.behind` was measured against
whatever `refs/remotes/*` was on disk — a repo nobody had fetched reported
"up to date" indefinitely, which made an "out of date" warning meaningless.

New `electron/fs/git-sync.ts`: throttled `fetch --prune` (3 min per repo,
in-flight deduped, never throws — offline and no-remote are ordinary),
fast-forward-only `pull`, `updateFromMain` for a worktree trailing trunk, and
the guarded `checkoutBranch`. The branch menu shows a Pull row when trunk is
behind its upstream and an update row per worktree behind trunk.

`listBranches` gained upstream tracking and distance-from-trunk. Note the two
`for-each-ref` calls: `%(ahead-behind:)` is git 2.41+, and an unknown format
atom fails the _whole_ command, so bundling it with `%(upstream:*)` cost every
older install (Ubuntu 22.04 still ships 2.34) its pull prompt as collateral.
Split, old git loses only the behind-trunk markers, rendered as unknown rather
than as zero.

## Verification

`npm run validate` green: typecheck, lint, prettier, 741 unit tests, 22 e2e.
New `electron/fs/git-sync.test.ts` runs real git against a local
clone-as-remote — ff-only refusal on diverged history, dirty guards on pull /
update / checkout, conflict abort leaving a clean tree, and the held-branch
message.
