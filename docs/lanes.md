# Lanes

A **lane** is one unit of work: a session, the branch it runs on, the worktree
that branch is checked out in, and the pull request it becomes. Phosphor shows all
four on a single sidebar row, and this document is the contract for that row.

Related: [extensions.md](extensions.md) for the artifact tools a lane can
call.

## The row

```
● 🚀  Give Me The Text Here
      9m · wt · give-me-the-text-here · ±2                  #418 ✓✓
```

Five parts, each owned by a different module:

| part          | source                      | note                                                            |
| ------------- | --------------------------- | --------------------------------------------------------------- |
| indicator dot | `SessionIndicator`          | derived, never stored: streaming > unseen > live > disk         |
| marker        | `lib/laneMarker.ts`         | fixed 18px slot                                                 |
| title         | `lib/sessionTitle.ts`       | live name beats scanned name                                    |
| subtitle      | `sessionSubtitle.ts`        | `·`-joined segments, branch is the only one allowed to truncate |
| PR chip       | `prChip.ts` + `PrBadge.tsx` | right-aligned trailer, **not** a subtitle segment               |

The subtitle and the PR chip are deliberately separate. Segments are joined
with `·` and truncate in order; the chip is `ml-auto` so it forms a scannable
column down the sidebar instead of floating after a branch name whose width
varies per lane.

**The row carries no spend.** A per-lane dollar figure is a detail you go
looking for, not a way to choose a lane, and it competed with the branch for
the row's one truncating slot. It lives in the row's context menu ("Copy
spend"), the Home ledger and the context meter's Cost row instead.

`LanePrefs.prStatus` (default **on**) decides whether the chip renders at all,
and a chip only renders once there is something to say:
`showChip = prStatus && (pullRequest || confirmedNoPr)` — gating on the raw
preference put an empty trailer on every plain non-worktree branch with no
confirmed PR. Settings → Workspaces → "PR status on lanes".

## Markers

An emoji pinned left of the title. Two rules, and both are about the **column**
rather than the glyph:

1. **The slot is fixed width and always rendered** (unless markers are off
   entirely). A slot that collapses on an unmarked lane shifts every title in
   the list, the left edge goes ragged, and the eye has to re-find the title on
   each row. That is the thing the column exists to prevent.
2. **The fallback is derived, not stored.** `SessionMeta` is scanned out of
   pi's own `.jsonl`; Phosphor does not own that format and must not add fields to
   it. Explicit choices live in `AppPrefs.laneMarkers` keyed by session path;
   every other lane hashes its **branch**.

Keying on the branch and not the title is load-bearing: Phosphor names a session
only after its first turn **ends**, so a title-derived marker would change
under the user the moment the auto-namer landed. The branch exists from the
moment the worktree does.

Because the fallback is total, the override map is safe to prune — a dropped
entry degrades a lane to its auto marker, never to a blank row.
`PendingSessionRow` renders the slot too, or the swap to a real row mid-turn
would shift the title.

`LanePrefs.markers` has three values, and the third is not the same as the
second: `auto` derives for everyone, `manual` respects choices and derives
nothing, `off` removes the column and reclaims its width. `off` also wins over
an explicit choice, so turning markers off does not leave the ones you picked
behind.

## PR status

`electron/fs/gh-cli.ts` is the only place Phosphor shells out to `gh`, and it is
**read-only by design**: no push, no create. Those are outward-facing writes
and belong behind an explicit confirmed action, which is why the `↑ no PR` chip
is inert rather than a one-click create button.

Two queries, and the distinction matters:

- `ghPrForBranch` — one branch. Used by the top-bar branch popup.
- `ghPrsForRepo` — the whole repo, indexed by `headRefName`. Used by the
  sidebar.

**Never fan `ghPrForBranch` across the sidebar.** That is 8-20 subprocesses per
refresh. The batched sibling exists for the same reason `git:info` grew
`git:infoBatch`.

`stores/pullRequests.ts` is keyed by **repo path**, not session: a sidebar
group is exactly one repo, because worktrees fold into their main checkout. A
lane's PR is joined at render time through `gitByCwd[cwd].branch` — `SessionMeta`
has no branch field to hang it on.

Refresh is event-driven (window focus, disk listing change) and only for
**expanded** groups, matching the session-dir watchers. The store coalesces
anything inside `PR_STALE_MS`, so calling `refresh` from several triggers is
free.

Every `gh` failure is a normal state, not an error: not installed, not
authenticated, no GitHub remote. All of them land as an empty map and render as
no chip. Nothing here raises a toast.

**Every `gh` run — the availability probe included — goes through
`piProcessEnv`**, so PATH is the login shell's. A GUI launch inherits
launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which has no Homebrew in it,
so a bare `execFile('gh', …)` fails with ENOENT in the installed app while
working in `npm run dev`. The probe caches its answer for the process
lifetime, so that one miss meant no chip on any lane, ever, until the app
restarted. Guard: `electron/fs/gh-cli.env.test.ts`.

**"No PR yet" is inferred, and inference needs a stricter gate than a real
chip does.** `gh` never reports absence — a branch with no PR just doesn't
appear in the map, which is indistinguishable from gh being unavailable
entirely. The sidebar only renders the `↑ no PR` fallback once a fetch for
that repo has actually completed (`fetchedAt > 0`, never true while gh is
missing/unauthenticated/remote-less) **and** the lane is a worktree. A
non-worktree branch — most commonly the trunk itself, checked out directly —
isn't "a lane" in the sense this document opens with, and guessing "you could
open a PR" there is wrong far more often than it's right. A **confirmed**
chip carries no such restriction: if `gh` reports a PR for a non-worktree
branch, it renders same as any other lane.

### The chip is one token carrying two signals

Colour is PR state; the trailing glyph is the check/review verdict. A second
chip would double the ink on the densest line in the app and truncate the
branch to nothing, and the two are read together in practice ("is it in, and is
it green").

| variant             | meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `open` / `approved` | open, checks green; `✓✓` once a human approved                 |
| `failing`           | checks red. The only state that earns colour at rest           |
| `pending`           | checks still running                                           |
| `blocked`           | green, but changes requested: blocked on a person, not a build |
| `conflict`          | ⚠ can't merge no matter what checks say — needs a rebase       |
| `draft`             | neutral. A draft is not a claim on your attention              |
| `merged`            | violet. The "this lane is done" signal                         |
| `closed`            | closed unmerged                                                |
| `no-pr`             | inert fallback — `↑ no PR`, no number, not a link              |

**Terminal states beat check state, and conflict beats check state too.** A
merged PR whose last run was red is still merged; colouring it red sends the
reader to fix a branch that is already in. A conflicting PR is unmergeable
regardless of how its checks come back, so `conflict` outranks `failing` and
`pending` the same way — but loses to `draft`, which stays neutral even when
the underlying branch has conflicts, because a draft isn't ready for review
either way.

`--px-merged` exists because in `--px-success`, "merged" and "open and green"
are indistinguishable — and those are the two states the sidebar is scanned to
tell apart. Merged is what makes PR status and bulk delete one feature.

The chip is a `role="link"` span, **not a button**: the row is already a
`<button>` and nesting one is invalid HTML. `tabIndex={-1}` keeps it out of the
tab order, because one focusable chip per lane would double the sidebar's tab
stops. The row context menu's **Open pull request** item is therefore the
keyboard route, not a nicety. The two are a pair.

## Naming

A lane is named once, after its first turn ends, by a one-shot `pi -p` call
(`pi:generateTitle` → `electron/pi/session-naming.ts`). The title then flows to
the branch as well as the session, so the sidebar group, the branch chip and
the title all agree.

Two naming passes must never run for one session. `startChat` owns naming for
chats it creates and passes `autoName: false` to suppress the session store's
own pass.

`titleArgs` strips everything a title does not need — tools, context files,
skills, prompt templates — because the naming call once carried ~35,000 tokens
of harness to produce a 15-token title. **`--no-extensions` is conspicuously
absent**: providers register through extension discovery, so `-ne` makes
`pi-claude-cli` an unknown provider and the run fails outright.

`pi -p` blocks until stdin reaches EOF, so it must never run through
`execFile`. See `electron/pi/print-mode.ts`.

**A one-shot must also opt out of the Claude provider's process park.**
pi-claude-cli >= 0.7.0 keeps one CLI process per session and parks it after
`result` for the next turn, which holds pi's event loop open — so `pi -p`
prints its title and then does not exit for ten minutes. The naming env
passes `claudeOneShotEnv()` (`PI_CLAUDE_CLI_KEEPALIVE_MS=0`); a title run has
no next turn to park for. `runPrintMode` also keeps whatever stdout arrived
before a timeout, so a slow exit can no longer throw away a finished title.

## Preferences

`LanePrefs` in `AppPrefs.lanes`, edited in Settings → Workspaces, stored via
`app:setLanePrefs`.

| pref                            | default | reaches                                  |
| ------------------------------- | ------- | ---------------------------------------- |
| `markers`                       | `auto`  | the sidebar row                          |
| `autoName`                      | `true`  | both naming passes                       |
| `nameMinWords` / `nameMaxWords` | 2 / 5   | the naming prompt                        |
| `nameMaxLength`                 | 60      | `sanitizeTitle`, after the model replies |
| `branchSlugMaxLength`           | 40      | `slugifyTitle`, so branch and folder     |

Branch **prefix** is separate and lives in `WorktreePrefs.branchPrefix`,
alongside the switch that decides whether a chat gets a branch at all. The
split is deliberate: `WorktreePrefs` decides _whether_ a lane gets a branch,
`LanePrefs` decides what the resulting lane _looks like_. A user with worktrees
off still names sessions.

**Every number here is clamped twice**, by `normalizeLanePrefs` in both the
renderer and the main process. Prefs are user-editable JSON and these values
reach a prompt, a git ref and a filesystem path. The renderer clamp is not
redundant: the settings UI reads back the value it just wrote, so an
out-of-range entry has to be corrected locally too or the field and the stored
pref disagree until a reload.

`nameMaxWords` can never fall below `nameMinWords`, or the prompt asks for
"5-2 words".

`LanePrefs` lives in its own leaf store (`stores/lanePrefs.ts`) rather than in
`stores/settings.ts`, which calls `window.matchMedia` at creation time.
Importing that from `stores/sessions.ts` breaks every non-jsdom suite that
touches sessions. Hydration still happens in `settings.ts`, so there is one
prefs round-trip on launch.

## Finding a lane

A magnifier in the workspace header (`Sidebar.tsx`, left of the `⋯` menu)
opens a search field **under** that header, pushing the group's lanes down. It
filters that group only: search is per project, because the header it hangs
off is.

`laneSearch.ts` matches a query against the three identities the row already
shows — **title, branch, and PR (number and title)** — because those are what a
reader remembers a lane by. Both sides are lowercased with every run of
non-alphanumerics collapsed to a space, so `#412` finds `412` and
`fix-and-rebase-pr-130` answers to `fix rebase`. Terms are **ANDed and
order-free**; matching is substring, not subsequence, because a three-letter
subsequence matches nearly every branch-shaped string and reads as a filter
that did nothing.

Four rules hold the interaction together:

- **Enter commits, typing does not.** On this list the rows are the
  navigation, and a per-keystroke filter makes them jump under a reader who is
  still deciding what to type.
- **Closing always retracts.** The `x` (shown only once a filter is in force)
  and Escape both clear the filter _and_ close the bar. A closed bar still
  hiding lanes is an unexplained empty sidebar.
- **Opening expands the group.** A filter on a collapsed group hides its own
  result.
- **Selection follows what is visible.** Select-all and shift-ranges read the
  filtered list, so a bulk delete can never take a lane the filter is hiding.

Placeholder rows (`PendingSessionRow`) stand aside while a filter is on: they
carry no name, branch or PR yet, so a filter can only be wrong about them.
Live names are matched as well as scanned ones — pi writes a session file only
when a turn ends, so a lane renamed mid-turn is findable under the name on
screen. That subscription is a joined **string**, not the session map, so
streaming re-renders nothing.

## Deleting lanes

Selection is scoped to **one group**, which is one repo. A destructive confirm
spanning two repos is how you delete the wrong branch. The Pinned list mixes
projects and is not selectable at all.

The checkbox **replaces the indicator dot in the same gutter**, so entering
select mode shifts nothing, and it is revealed on hover rather than occupying a
permanent column. "Select all lanes" lives in the workspace `⋯` menu, not as a
header icon: the header's fixed toolbar is four controls wide in a 208px
sidebar, and search earned the fifth slot by being the more frequent act.

Deleting is three resources, and only the first two default on:

1. the session transcript, to the OS Trash (`shell.trashItem`, recoverable) —
   pi's `.jsonl` **and** its paired Claude Code transcript
2. the worktree directory, gone
3. the branch, only when its work is already on the trunk

**A branch is deleted only when it is proven merged.** `git branch -d` alone is
not that proof: it tests ancestry, and Phosphor lands PRs as squash merges, which
leaves no ancestry link — so `-d` refused every merged lane and every delete
reported an error. `isBranchMerged` adds the squash test (`git cherry` against a
commit built from the branch's tree), and `-D` runs only when it returns true.
Anything it cannot prove is kept and reported; that is not a reason to keep the
transcript, so the lane still goes.

**Remote branch deletion is not offered.** No channel exists for it and a bulk
flow is the worst place to introduce the least reversible operation.

### Two tiers of guard

- A **blocker** refuses: a turn in progress. Struck through in the confirm,
  excluded from the count, reported afterwards rather than silently dropped.
- A **warning** is lost work: uncommitted changes, unpushed commits, an open
  PR. These raise **one** acknowledgement for the whole selection. A per-lane
  confirm trains you to click through it, which is how the guard stops working.

Warnings carried only by a _blocked_ lane do not count — it is not being
deleted.

### Ordering, and why it is that way

Per lane: dispose the live session, remove the worktree, then delete the
transcript. Worktree removal is the step that actually fails in practice (a
terminal cwd'd into the lane, a dirty tree), and failing first leaves the lane
whole and still in the sidebar. The other order leaves a transcript in the
Trash and a directory on disk, which is worse than doing nothing.

The loop is **sequential, not `Promise.all`**: each lane disposes a subprocess
and runs git, and N of those at once is how a worktree gets removed while its
own pi is still writing.

Cancellation is checked **between** lanes only. Stopping mid-lane is how you
get a half-deleted one.

### Feedback is not a toast

`stores/sessions.ts` publishes `bulkDelete` progress and `BulkDeleteProgressModal`
renders it. Per-lane outcomes matter: a worktree that would not remove is the
common case and that lane is still in the sidebar. A toast reading "3 deleted"
when four were selected is exactly the silent failure this exists to prevent.

## Reclaiming lanes automatically

Deleting a lane by hand is the only thing that ever freed its disk, so a
long-lived install keeps a worktree — and its own `node_modules` — per lane
forever. Measured on one machine: 9.1 GB across 70 worktrees.

Settings → Advanced → **Maintenance** runs a sweep. It has two switches,
because measuring and deleting are different risks:

- **Reclaim dead lanes** (on) sweeps hourly and **reports**. It never deletes.
- **Delete automatically** (off) is what lets a sweep act.

**Reclaim now** deletes without flipping the pref, and cannot delete more than
a sweep would: both paths run the same policy.

Six conditions must all hold before a worktree is a candidate
(`electron/maintenance/policy.ts`), and every rejection is reported with its
reason so a sweep is auditable: not the main checkout, on a branch, clean,
not a live session's cwd or an open workspace, **proven merged** (the same
squash test the manual delete uses), and untouched for `minAgeHours`. Deletion
itself goes through `removeWorktree`, which refuses a dirty tree on its own.

The grace period exists because a branch can land while its lane is still
being read, and it counts pi's session directory for that cwd as use — a lane
you read but never edit leaves the directory untouched while its transcript
keeps moving.

Sizes come from `du`, which Windows has not got; an unmeasured size reports
"unknown" and the policy never depends on the number. The scheduler is a plain
unref'd interval in main with a 5-minute warmup and a 15-minute floor, one
sweep at a time.
