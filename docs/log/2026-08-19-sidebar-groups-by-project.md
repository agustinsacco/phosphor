# 2026-08-19 — Sidebar groups sessions by project, not by worktree folder

Follow-up to the "Sidebar identity" entry above: `worktreeAwareName()` fixed
the _label_ a worktree's group showed ("Phosphor (test)" instead of "test"), but
each worktree still got its own group, since grouping keyed on the physical
workspace folder and a linked worktree is a different folder from its main
repo. Opening both left the sidebar reading as two projects — "Phosphor" and
"Phosphor (test)" — for what is one repo on two branches.

`groupSessionsByProject()` (new, `src/features/sessions/groupSessions.ts`)
folds a worktree's sessions into its main repo's group instead: the group key
is `GitInfo.mainRepoPath` when `isWorktree` is set, falling back to the
worktree's own path only when the main repo isn't itself a known workspace (so
a worktree opened on its own still gets a reachable header). The per-session
"wt" subtitle chip (already existed, driven by the row's own `cwd`) is what
now carries the worktree/branch signal — the group no longer needs to.

`GroupedSessions` gained `paths: string[]` (every physical folder merged into
the group); group-level effects — the watch/unwatch pass, "refresh on
expand", and the default-collapsed check for the active workspace — now
operate over all of a group's `paths`, not a single `workspacePath`. The
"remove/merge worktree" item on a group's context menu only survives for the
case where a group's representative folder is itself the worktree (main repo
unknown); once merged, that control already lives on the session's own
branch chip (`GitChips`), so it isn't duplicated at the ambiguous,
multi-folder group level.

Coverage: 5 unit tests for `groupSessionsByProject` (plain workspace, worktree
folded into its repo, fallback when the repo is unknown, two distinct
projects staying separate, pinned/live filtering). The e2e worktree-flow test
was asserting the _old_ behavior (a group header containing the branch name)
and is updated to assert one group plus the per-row worktree indicator
instead.
