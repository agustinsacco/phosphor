# Lanes

A **lane** is one unit of work: a session, the branch it runs on, the worktree
that branch is checked out in, and the pull request it becomes. Phosphor shows
all four on a single sidebar row, so "where is that task, and is it green?" is
one glance, not four tools.

Related: [worktrees.md](worktrees.md) for the branch lifecycle,
[extensions.md](extensions.md) for the artifact tools a lane can call.

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

The PR chip is `ml-auto`, so it forms a scannable column down the sidebar
instead of floating after a branch name of varying width.

**The row carries no spend.** A dollar figure is something you go looking for,
not a way to choose a lane. It lives in the row's context menu ("Copy spend"),
the Home ledger and the context meter's Cost row.

`LanePrefs.prStatus` (default **on**) decides whether the chip renders at all,
and a chip only renders once there is something to say: a known PR, or a
confirmed absence on a worktree lane. Settings → Workspaces → "PR status on
lanes".

## Markers

An emoji pinned left of the title. Two rules, both about the **column**:

1. **The slot is fixed width and always rendered** (unless markers are off).
   A slot that collapses on an unmarked lane shifts every title and the eye
   has to re-find it on each row.
2. **The fallback is derived, not stored.** Explicit choices live in
   `AppPrefs.laneMarkers` keyed by session path; every other lane hashes its
   **branch**. Phosphor does not add fields to pi's session format.

Keying on the branch, not the title, matters: a session is named only after
its first turn **ends**, so a title-derived marker would change under you the
moment the auto-namer landed. The branch exists from the moment the worktree
does.

`LanePrefs.markers`: `auto` derives for everyone, `manual` respects choices
and derives nothing, `off` removes the column and reclaims its width. `off`
wins over explicit choices.

## PR status

`electron/fs/gh-cli.ts` is the only place Phosphor shells out to `gh`, and it
is **read-only by design**: no push, no create. Those are outward-facing writes
and belong behind an explicit action, which is why the `↑ no PR` chip is inert
rather than a one-click create button.

Two queries:

- `ghPrForBranch` — one branch. Used by the top-bar branch popup.
- `ghPrsForRepo` — the whole repo, indexed by `headRefName`. Used by the
  sidebar. **Never fan the single-branch query across the sidebar**; that is
  8-20 subprocesses per refresh.

`stores/pullRequests.ts` is keyed by **repo path**, not session: a sidebar
group is exactly one repo, because worktrees fold into their main checkout. A
lane's PR is joined at render time through its cwd's branch.

Refresh is event-driven (window focus, disk listing change), only for
**expanded** groups, and coalesced inside `PR_STALE_MS`, so calling `refresh`
from several triggers is free.

Every `gh` failure is a normal state, not an error: not installed, not
authenticated, no GitHub remote. All render as no chip. Nothing here toasts.

Every `gh` run goes through `piProcessEnv`, so PATH is the login shell's. A GUI
launch inherits launchd's PATH, which has no Homebrew in it, and a bare
`execFile('gh', …)` would fail in the installed app while working in dev.

**"No PR yet" is inferred, and inference needs a stricter gate than a real
chip.** `gh` never reports absence; a branch with no PR simply does not appear
in the map, which looks the same as gh being unavailable. The `↑ no PR`
fallback renders only once a fetch for that repo has actually completed
**and** the lane is a worktree. A trunk checked out directly is not "a lane",
and guessing "you could open a PR" there is wrong more often than right. A
**confirmed** chip has no such restriction.

### The chip is one token carrying two signals

Colour is PR state; the trailing glyph is the check/review verdict. A second
chip would double the ink on the densest line in the app, and the two are read
together anyway ("is it in, and is it green").

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
merged PR whose last run was red is still merged. A conflicting PR is
unmergeable whatever its checks say, so `conflict` outranks `failing` and
`pending`, but loses to `draft`, which stays neutral either way.

Merged gets its own colour because in the success colour "merged" and "open and
green" are indistinguishable, and those are the two states the sidebar is
scanned to tell apart. Merged is what makes PR status and bulk delete one
feature.

The chip is a `role="link"` span, not a button (the row is already a button,
and nesting one is invalid HTML), and it is out of the tab order so it does not
double the sidebar's tab stops. The row context menu's **Open pull request** is
the keyboard route.

## Naming

A lane is named once, after its first turn ends, by a one-shot `pi -p` call
(`electron/pi/session-naming.ts`). The title flows to the branch as well as the
session, so the sidebar group, the branch chip and the title agree.

Two naming passes never run for one session: `startChat` owns naming for the
chats it creates and suppresses the session store's own pass.

`titleArgs` strips everything a title does not need (tools, context files,
skills, prompt templates) so the call is not carrying ~35,000 tokens of harness
to produce a 15-token title. `--no-extensions` is deliberately **absent**:
providers register through extension discovery, and without it `pi-claude-cli`
is an unknown provider and the run fails.

Two constraints on the one-shot, both silent when broken:

- `pi -p` blocks until stdin reaches EOF, so it never runs through `execFile`.
  See `electron/pi/print-mode.ts`.
- pi-claude-cli ≥ 0.7.0 parks its CLI process after a turn, which holds pi's
  event loop open, so a naming run would print its title and then not exit for
  ten minutes. The naming env passes `claudeOneShotEnv()`
  (`PI_CLAUDE_CLI_KEEPALIVE_MS=0`). `runPrintMode` also keeps whatever stdout
  arrived before a timeout, so a slow exit cannot throw away a finished title.

## Preferences

`LanePrefs` in `AppPrefs.lanes`, edited in Settings → Workspaces.

| pref                            | default | reaches                                  |
| ------------------------------- | ------- | ---------------------------------------- |
| `markers`                       | `auto`  | the sidebar row                          |
| `autoName`                      | `true`  | both naming passes                       |
| `nameMinWords` / `nameMaxWords` | 2 / 5   | the naming prompt                        |
| `nameMaxLength`                 | 60      | `sanitizeTitle`, after the model replies |
| `branchSlugMaxLength`           | 40      | `slugifyTitle`, so branch and folder     |

The branch **prefix** is separate, in `WorktreePrefs.branchPrefix`, beside the
switch that decides whether a chat gets a branch at all. `WorktreePrefs`
decides _whether_ a lane gets a branch; `LanePrefs` decides what it _looks
like_. Worktrees off still names sessions.

**Every number is clamped twice**, in the renderer and in main. These values
reach a prompt, a git ref and a filesystem path, and the settings UI reads back
the value it just wrote, so an out-of-range entry must be corrected locally too.
`nameMaxWords` can never fall below `nameMinWords`.

`LanePrefs` lives in its own leaf store (`stores/lanePrefs.ts`), not in
`stores/settings.ts`, which calls `window.matchMedia` at creation and would
break every non-jsdom suite that touches sessions.

## Finding a lane

A magnifier in the workspace header opens a search field **under** that
header. It filters that group only: search is per project because the header
it hangs off is.

`laneSearch.ts` matches against the three identities the row shows: **title,
branch, and PR (number and title)**, because those are what you remember a lane
by. Both sides are lowercased with runs of non-alphanumerics collapsed to a
space, so `#412` finds `412` and `fix-and-rebase-pr-130` answers to
`fix rebase`. Terms are ANDed and order-free; matching is substring, not
subsequence, because a three-letter subsequence matches nearly every
branch-shaped string.

Four rules:

- **Enter commits, typing does not.** The rows are the navigation, and a
  per-keystroke filter makes them jump under you.
- **Closing always retracts.** The `x` and Escape both clear the filter _and_
  close the bar. A closed bar still hiding lanes is an unexplained empty
  sidebar.
- **Opening expands the group.** A filter on a collapsed group hides its own
  result.
- **Selection follows what is visible.** Select-all and shift-ranges read the
  filtered list, so a bulk delete can never take a lane the filter is hiding.

Placeholder rows stand aside while a filter is on: they have no name, branch
or PR yet. Live names are matched as well as scanned ones, so a lane renamed
mid-turn is findable under the name on screen.

## Deleting lanes

Selection is scoped to **one group**, which is one repo. A destructive confirm
spanning two repos is how you delete the wrong branch. The Pinned list mixes
projects and is not selectable.

The checkbox replaces the indicator dot in the same gutter, so entering select
mode shifts nothing. "Select all lanes" lives in the workspace `⋯` menu.

Deleting is three resources, and only the first two default on:

1. the session transcript, to the OS Trash (recoverable): pi's `.jsonl`
   **and** its paired Claude Code transcript
2. the worktree directory, gone
3. the branch, only when its work is already on the trunk

**A branch is deleted only when it is proven merged.** `git branch -d` tests
ancestry, and a squash merge leaves no ancestry link, so `-d` refuses every
squash-merged lane. `isBranchMerged` adds the squash test (`git cherry`
against a commit built from the branch's tree), and `-D` runs only when it
returns true. Anything unproven is kept and reported; the transcript still
goes.

**Remote branch deletion is not offered.** A bulk flow is the worst place to
introduce the least reversible operation.

### Two tiers of guard

- A **blocker** refuses: a turn in progress. Struck through in the confirm,
  excluded from the count, reported afterwards.
- A **warning** is lost work: uncommitted changes, unpushed commits, an open
  PR. These raise **one** acknowledgement for the whole selection. A per-lane
  confirm trains you to click through it.

Warnings carried only by a _blocked_ lane do not count; it is not being
deleted.

### Ordering, and why it is that way

Per lane: dispose the live session, remove the worktree, then delete the
transcript. Worktree removal is the step that fails in practice (a terminal
cwd'd into it, a dirty tree), and failing first leaves the lane whole and still
in the sidebar. The other order leaves a transcript in the Trash and a
directory on disk.

The loop is **sequential**: each lane disposes a subprocess and runs git, and N
at once is how a worktree gets removed while its own pi is still writing.
Cancellation is checked between lanes only.

### Feedback is not a toast

`BulkDeleteProgressModal` shows per-lane outcomes. A worktree that would not
remove is the common case, and that lane is still in the sidebar. "3 deleted"
when four were selected is exactly the silent failure this prevents.

## Reclaiming lanes automatically

Deleting a lane by hand is the only thing that frees its disk, so a long-lived
install keeps a worktree, and its `node_modules`, per lane forever. That adds
up to gigabytes.

Settings → Advanced → **Maintenance** runs a sweep with two switches, because
measuring and deleting are different risks:

- **Reclaim dead lanes** (on) sweeps hourly and **reports**. It never deletes.
- **Delete automatically** (off) lets a sweep act.

**Reclaim now** deletes without flipping the pref and cannot delete more than a
sweep would; both run the same policy.

Six conditions must all hold before a worktree is a candidate
(`electron/maintenance/policy.ts`), and every rejection is reported with its
reason: not the main checkout, on a branch, clean, not a live session's cwd or
an open workspace, **proven merged** (the same squash test as manual delete),
and untouched for `minAgeHours`. Deletion goes through `removeWorktree`, which
refuses a dirty tree on its own.

The grace period exists because a branch can land while its lane is still
being read. pi's session directory for that cwd counts as use, so a lane you
read but never edit is still "touched".

Sizes come from `du`, which Windows lacks; an unmeasured size reports "unknown"
and the policy never depends on the number. The scheduler is a plain interval
in main with a 5-minute warmup and a 15-minute floor, one sweep at a time.
