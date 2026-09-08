# 2026-08-28 — The sidebar showed one session per project until you collapsed it

A project with several lanes listed one session. Collapsing the group and
expanding it again listed them all. That was reproducible and load-bearing:
users learned the toggle as a ritual.

A **lane** is a chat in its own git worktree at
`<repo>/.phosphor/worktrees/<slug>`. Separate cwd, separate pi session directory,
separate scan target. Lanes are deliberately never written to `recents`
(`src/stores/workspaces.ts`), so they reach the sidebar only through async
`git:listWorktrees` discovery.

## Four things stacked up

1. **The boot scan caps at 8 workspaces by LIST POSITION**
   (`refreshAllDisk`, `src/stores/sessions.ts`).
2. **Lanes are appended last** to `knownWorkspaces` (`Sidebar.tsx`), so a
   project's own lanes are exactly what falls off the end of that cap.
3. **The watcher cannot backfill.** `session-watcher.ts` runs chokidar with
   `ignoreInitial: true`, so a `.jsonl` already on disk when the watch starts
   fires no event. Watching an expanded group therefore proves nothing about
   whether its sessions have ever been listed.
4. **Only `toggleGroup` scanned a whole group**, uncapped, per folder. That is
   the entire reason the collapse/expand dance worked.

A fifth defect, not user-reported, sat underneath: `isGroupCollapsed` defaulted
to open when `group.scanned`, and `scanned` is AND-ed across every folder
merged into the group. Discovering one lane flipped it false, so a group the
user had open could default shut — and the watcher effect then unwatched it.

## The fix

- `refreshMissing(paths)` scans only folders with no `scanStatus` entry. The
  sidebar calls it for every unscanned folder of an **expanded** group, from
  the same effect that manages watchers. Uncapped, because an expanded group
  is a group the user is looking at.
- It is idempotent by construction — a scanned folder has a status entry — so
  an effect keyed on the groups themselves settles after one pass instead of
  looping.
- `anyScanned` replaces `scanned` in the collapse default. `unscannedPaths`
  names what is still coming.
- Worktrees are re-listed when a live session runs in a lane discovery has not
  found yet. Previously `worktreeListedKey` only changed when the set of
  **roots** changed, and starting a lane does not touch recents, so a lane was
  visible only while its session stayed live.

## Loading feedback

"Loading sessions…" was one line, character-for-character as quiet as the
empty state next to it. Now:

- never attempted → skeleton rows;
- partially scanned → the rows we have, plus `loading N more folders…`;
- errored → unchanged, "Couldn't load sessions" and a Retry.

## What did not change

The 8-workspace cap. It still exists and still governs collapsed groups: a
cold boot with 30 known folders must not do 30 directory walks before first
paint. The bug was never the cap, it was that nothing ever came back for what
the cap skipped.

The watcher's `ignoreInitial: true` also stays. Backfill belongs in the
renderer scan; making the watcher replay a directory on every subscribe would
put an unbounded read behind every group expansion.

Amends [2026-08-23-sidebar-loading-sessions-is-not-loading.md](2026-08-23-sidebar-loading-sessions-is-not-loading.md),
which recorded the cap's lazy-load story as complete.

Tests: `src/stores/sessions.test.ts` (refreshMissing),
`src/features/sessions/groupSessions.test.ts` (scan bookkeeping across a merged
group).
