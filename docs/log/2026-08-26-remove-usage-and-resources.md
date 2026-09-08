# 2026-08-26 — Deleting the Usage view and the resource monitor

Both were sidebar nav rows, both landed in P12, and neither earned its keep.
They are gone, along with everything that existed only to feed them.

**Usage** answered "what has every session on disk cost", by walking every
directory under pi's sessions root and rolling the numbers up per workspace.
The information itself was never wrong; it was just not information anyone
acted on. Per-session cost already shows in the sidebar subtitle
(`sessionSubtitle.ts`), per-session tokens and cost in the context meter
popover, and per-workspace rollups on the home screen — three places that a
user passes anyway. The modal was a fourth view of the same numbers behind an
extra click and a full-disk scan.

**Resources** sampled `ps` every two seconds and attributed RSS and CPU to each
session's pi subprocess and terminals, in a modal and in an always-on-top
floating window. It was correct and it was cheap when closed, but knowing a pi
tree holds ~200 MB does not tell you what to do about it, and the two surfaces
existed for a diagnosis nobody was making from inside the app. Activity Monitor
covers the same ground when the question actually comes up.

## What came out with them

Deleting the views was the small part. Both had a full main-process tail:

- `src/features/usage/` and `src/features/resources/` (both entire).
- `electron/resources/` — the `ps` sampler, the pure process-tree maths, the
  2-second reference-counted tick loop, and the floating `BrowserWindow`.
- `electron/ipc/resources-handlers.ts`, the four `resources:*` channels, the
  `resources:sample` push channel and its `onResourceSample` preload member.
- `sessions:usage` and `usageSummary()` in the session scanner. `SessionMeta`
  keeps every field it had: the sidebar, the home tiles and the context meter
  all read them.
- `UsageTotals` / `WorkspaceUsage` / `UsageSummary` and the whole resource
  monitor block of `shared/models.ts`.
- The `?view=monitor` branch in `src/main.tsx`. The renderer entry now has one
  root, not two.
- `ptyManager.pidsBySession()`, whose only production caller was the monitor's
  injected collector in the IPC composition root. `registerIpcHandlers()` lost
  its `isDev` argument with the same edit — the floating window was the only
  thing that needed it.
- Two e2e tests, and the `setCheckbox` retry helper that existed solely because
  the monitor panel re-rendered under a live sampler and moved its own
  checkbox out from under Playwright's click.

## Two unrelated things found while checking

- **Two dead IPC channels.** `pi:listLiveSessions` and
  `app:getPathForDisplay` each had a main-process handler and zero renderer
  callers. Removed. The registry list they exposed is still used inside main;
  the renderer gets workspace names from `lib/path.ts`.
- **A unit test that only passed on Linux.** `git-worktrees.test.ts` matched a
  worktree by the path it had joined itself, against the path git reports. On
  macOS the fixture lives under `/var/folders/…`, git resolves it to
  `/private/var/folders/…`, and the match silently found nothing — so the
  assertion read `undefined` and failed locally on every macOS run while CI
  (Linux, no symlink) stayed green. Fixed here and, independently, in
  [#81](https://github.com/agustinsacco/Phosphor/pull/81); that version landed
  first and this branch took it on rebase, since matching `path || realPath`
  mirrors what every production lookup does.

Verification: typecheck, lint, 1052 unit tests across 100 files, e2e green.

---

## Addendum — the top bar named the worktree, not the project

Reported against this branch, same PR. With a worktree session open, the top
bar's folder chip read `hey-2` — the worktree folder's basename, which is the
branch slug — so the bar claimed the user had switched to a workspace that does
not exist. The switcher beside it said `Phosphor (Phosphor/hey-2)`, and the sidebar
group said `PHOSPHOR`: three surfaces, three answers.

`useActiveWorkspace()` is right to return the worktree path. That path is the
session's real cwd, and the file tree, git calls and terminals all need it.
Only the _display_ was wrong, and each surface had rolled its own answer:

- `WorkspaceChip` called `workspaceName(workspacePath)` — the raw basename, no
  git info consulted at all. This is the reported bug.
- `worktreeAwareName()` (switcher, row badge, window title) resolved the repo
  but appended the branch, from before `BranchControl` and the row subtitle
  each showed the branch themselves. Two answers to one question.
- `groupSessionsByProject` and `OrchestrationTab` each keyed off
  `git.isWorktree && git.mainRepoPath` inline.

That last shape is the deeper fault. `gitByCwd` is filled by a batched
`git:infoBatch` round trip, so **every one of these renders at least once with
no git info**, and a cwd whose batch never resolves renders that way for good.
Keyed on git info alone, a fresh worktree gets its own sidebar group headed by
the branch slug, which then collapses into the project group a moment later.

`projectPathFor(path, git)` in [src/lib/path.ts](../../src/lib/path.ts) is now
the one answer, with two sources that fail in opposite directions: `mainRepoPath`
when git has answered (authoritative, and works for a worktree anywhere on
disk), else the path shape `<repo>/.phosphor/worktrees/<name>` (needs no I/O, but
only knows worktrees Phosphor created). `projectName()` wraps it for display and
deliberately carries no branch.

Applied to every surface that answers "which project am I in": the top bar and
home composer chips, the sidebar switcher, session row badges, the home screen
prose, the orchestrator banner, the orchestration settings title, and the
sidebar's project grouping. Surfaces that are about a worktree _as a worktree_ —
`BranchControl`, `BranchPicker`, `RemoveWorktreeModal`, the `startChat` slug
collision check — still use `workspaceName` on purpose.

**The window title is the one exception**, and it keeps the branch:
`Phosphor (Phosphor/hey-2) — Phosphor`. This branch originally dropped it, on the rule
that a workspace display never shows a worktree.
[#81](https://github.com/agustinsacco/Phosphor/pull/81) landed the opposite call
with a reason that holds — the title is one line with nowhere else to put the
branch, unlike every in-app surface, which sits under a top bar that names the
folder and the branch separately — so the rebase kept `worktreeAwareName` for
it. It now delegates to `projectName`, so it inherits the path-shape fallback
below and reads `Phosphor (…)` rather than `main (…)` before git info arrives.

Guarded by a new assertion in the existing worktree-flow e2e test, on the real
worktree session it already creates. Verified the honest way: restoring
`workspaceName` in the chip fails it at `smoke.spec.ts:612`. Plus unit tests
for `projectPathFor`/`projectName`, and one for a worktree grouped before its
git info arrives.

---

## Addendum 2 — the active session row had an amber crescent

Same branch. In light mode the selected sidebar row carried what read as a
curved shadow down its left edge. It was a 2px `border-l-accent` rail on a
`rounded-lg` row: a border follows the corner radius, so an 8px radius bent it
into a crescent instead of a straight rail.

The rail was itself a workaround, and the comment it carried said so — "the
full-tint background disappears at a glance". It disappeared because the fill
was `bg-bg-secondary`, and in light mode `--px-bg-secondary` (`#efeff1`) sits
two units on the **lighter** side of the sidebar ground (`--px-sidebar`,
`#ededef`). An active row was therefore invisible, and the accent rail was
bolted on to make it findable. Dark mode never had the problem, which is why
one theme looked deliberate and the other looked like a rendering artifact.

Fixed at the token, not at the row. `--px-sidebar-hover` / `--px-sidebar-active`
move **away** from the sidebar ground in whichever direction the theme needs —
darker in light (`#e6e6ea` / `#dedee3` against `#ededef`), lighter in dark
(`#221f19` / `#2d2921` against `#15130f`). A plain fill is then legible in both
modes, so:

- the accent rail is gone, and with it the `pl-[calc(0.5rem-2px)]` that
  compensated for it — the left edge is flush again,
- the radius drops `rounded-lg` → `rounded-md` (8px → 6px), squarer, matching
  the Claude Desktop reference the request pointed at,
- session state (live / streaming / unseen) stays entirely the indicator dot's
  job, which is where it belonged.

`PendingSessionRow` gets the identical treatment — it is swapped for a real
`SessionRow` the moment the session file lands, and any difference between the
two reads as the row twitching. The sidebar's other rows on the same ground
(nav rows, the workspace switcher, group-header icon buttons) had the same
invisible `hover:bg-bg-secondary` and now use `sidebar-hover` too.

Verified in the browser harness in both themes, by computed style rather than
by eye: light `#ededef` ground → `#dedee3` active; dark `#15130f` → `#2d2921`;
6px radius, `border-left-width: 0`, uniform 8px padding on both.

### The chips inside a row, same sweep

`wt`, `suspended` and the workspace badge had the same fault for the same
reason: `bg-bg-secondary` on a sidebar ground. They read as bare text in light
mode.

A flat token cannot fix these, because a chip's ground depends on the row it
sits in — `--px-sidebar` on an inactive row, `--px-sidebar-active` on the
selected one. Any flat colour picked for one washes out against the other.
So `--px-chip` is **translucent**: ink over paper in light
(`rgb(38 38 42 / 0.09)`), paper over ink in dark (`rgb(236 231 219 / 0.11)`).
An overlay holds the same step against every ground it lands on, which also
means it would work unchanged on the page and in a modal.

Measured composites, all four grounds, ~15-20 units of separation each:

| ground              |           | chip      |
| ------------------- | --------- | --------- |
| light, inactive row | `#ededef` | `#dddde0` |
| light, active row   | `#dedee3` | `#cfcfd4` |
| dark, inactive row  | `#15130f` | `#2b2a26` |
| dark, active row    | `#2d2921` | `#403c33` |

Chip text moved `text-text-tertiary` → `text-text-secondary`: tertiary on the
new fill is ~2.6:1, which is not a legible contrast for 11px text.

Not swept: the ~35 other `bg-bg-secondary` fills across the app. They sit on
`--px-bg` or `--px-surface`, where the token gives 8-16 units and reads fine —
the sidebar was the only ground where the step was _negative_.
