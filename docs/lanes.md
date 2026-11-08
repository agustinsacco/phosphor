# Lanes

A **lane** is one unit of work: a session, the branch it runs on, the worktree
that branch is checked out in, and the pull request it becomes. Phosphor shows
all four on a single sidebar row, so "where is that task, and is it green?" is
one glance, not four tools.

Related: [worktrees.md](worktrees.md) for the branch lifecycle,
[extensions.md](extensions.md) for the artifact tools a lane can call.

## Remote lanes

The sidebar lists authenticated Host lanes alongside local groups, with a machine
filter. A disconnected machine keeps its memory-only rows greyed, disabled and
labelled last known. Remote creation uses a machine and its configured repository.

Host + and New open the home composer, not a separate modal. A folder's + (New lane
in FOLDER) chooses that folder, in Desktop and the browser alike.
[Remote creation](remote-desktop.md#machine-context-and-lane-creation) owns the flow.

This Mac retains the local folder and branch flow. Selecting an unavailable Host never creates a local session.

The lane header reports the connection state. The composer and panes disable
while disconnected and recover when the Host snapshot is ready. See
[Remote Desktop](remote-desktop.md#machine-context-and-lane-creation).

Host lanes are selected the way This Mac's are (see
[Deleting lanes](#deleting-lanes) below): the same row box, shift ranges, bulk bar
and Escape. Remote repository menus offer **Select all lanes**, which turns into
**Clear selection**, and **Select merged lanes**, which can enter select mode with
nothing chosen. Selection follows the visible search results and includes only
lanes controlled by this client; a lane another device holds shows a disabled box
that says “Take control first.” The shared confirmation and non-blocking progress
surface apply;
Stop finishes the current deletion before cancelling the remainder. Every command
rechecks connection, capabilities and control, never takes over implicitly, and
is never retried on an uncertain result. Failures are reported per lane while
other lanes continue. Shared worktrees are removed only with their last successfully
deleted user; a failed or unselected lane keeps its directory. The Host refuses
dirty worktree removal rather than discarding changes.

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
and a chip renders only for a lane with a known PR. A lane without one shows
no chip, no placeholder and no "no PR" hint. Settings → Lanes → "PR status on
lanes".

**Delegated work keeps a live lane working.** The sidebar activity treatment
and Home board include active roots and descendants from that session's
`subagent-async` snapshot, even while the parent is quiet. A Host lane says
the same thing: its projection reads that snapshot (parsed in
`@phosphor/shared/subagent-fleet`) into the summary's `activity`, so a remote
lane row shows Working while background agents run, and the finished
attention chime waits for them. An explicitly
incomplete snapshot cannot establish that delegated work has settled. This
outranks merge readiness; a real human dialog still outranks running work.
A child's attention request belongs to its parent, not the "Waiting on you"
column. Snapshots are transient and are cleared with the live session. They
are not process-exit proof or authority to remove a child worktree.

## Forks and saved history

Fork, Clone and Rewind each create a new session file; pi never edits one in
place. The files look alike, so the sidebar decides by the **action** that
made them, never by their contents (shared entry ids and `parentSession`
describe ancestry, not permission to hide the source):

- **Fork and Clone** keep both rows, the source and the copy, even after their
  processes stop or the app restarts.
- **Rewind** records `old file → new file` (`AppPrefs.rewoundSessions`, keyed
  by file name so a folder rename cannot break it; written by `rewindToEntry`
  only, in the same store update that moves the session onto its new file).
  The sidebar folds the old file away while the old file is not live and a
  later version exists, following chains (A → B → C shows only C). "Exists"
  means on disk **or live**: pi writes a rewound branch with no reply yet only
  when its next turn ends, and until then the live session's placeholder row
  is the chat's one row. If the app quits before that file is written, the old
  row comes back. A pinned old file stays pinned. Deleting the successor
  brings the old row back. Nothing is deleted or written to pi's files.
- Opened some other way (palette, pin, restored session), an old version shows
  a banner, "This is the chat before a rewind. It continues in <name>", linking
  to the live version, so nobody resumes it by mistake.
- **Carrying on in an old version** makes it a chat of its own again: when a
  turn ends in it, its record is dropped and it keeps its row, beside the
  version that replaced it. Hiding it again would hide the newest work.

Rewinds made before this record existed are not folded: their duplicate rows
stay until you rename or delete one.

## Moving a lane

Desktop's row menus offer **Move to…** for stopped lanes, local and remote. Pick
This Mac or a connected Host, then one of its workspaces. A checked plan explains
what will land there and any blockers. The browser cannot relay transfers.

A move is a snapshot copy. The original is untouched, keeps its row, and is
never deleted automatically. The new lane keeps its conversation, exact supported
name, artifact versions, child-run history, pin and visible marker, without a
copy suffix or badge. It is not resumed automatically. **Open** continues it at
the destination. A fixed, model-visible notice records both locations, warns
about stale paths, and lists the attachments' new paths.

- **Folders without git:** the conversation moves, not the folder's files.
- **Same origin on another machine:** the target fetches the source branch and
  requires its exact commit. A clean matching Phosphor worktree can be reused;
  conflicting branches or folders are refused.
- **Another git workspace:** a fresh worktree/branch starts from the target's
  default branch. The source code stays behind; a taken branch name is refused.
- **Same repository on the same machine:** use Clone instead.

Uncommitted tracked or untracked work blocks a git lane; ignored files neither
block nor move. Detached/in-progress git state is refused. Submodules and LFS
cannot accompany a same-repository transfer yet. The target must have a pi at
least as new as the source's, the saved provider/model, and pi-claude-cli 0.10.0+
for Claude lanes. The dialog asks you to acknowledge that skills, extensions,
context files, MCP setup and accounts belong to the target, not the copy.

The bundle contains pi JSONL, its child runs and referenced subagent files,
Claude's paired ledger, prompt and sidecar, and available attachments. Missing,
changed or oversized attachments are skipped. Earlier transcript text is not globally
path-rewritten. Only the header location, child headers matching the source cwd,
colliding session identities and self-qualified artifact URLs are repaired.
Artifacts are rebuilt from the transcript. Credentials, terminal processes,
routine schedules and workspace files are never copied.

Limits: 256 MiB per bundle, 4,000 parts, 20 MiB per attachment, and 32 MiB per
transcript imported by a Host. Host lane names above 80 characters are refused,
not shortened; other transfers support names up to 200 characters. Both Hosts
must stay connected for Host-to-Host moves; Desktop carries a private temporary
bundle between them. An unconfirmed result is never automatically retried:
check the destination before trying again.

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
wins over explicit choices. This preference is the feature gate, available in
Settings → Lanes → Lane markers. Turning it off also hides the picker;
existing choices are kept for when markers are enabled again.

Click a saved lane's marker (including its empty placeholder), or right-click
the row and choose **Lane marker…**, to change it. The picker bundles the
Unicode emoji catalog locally, with name/emoji search and category filtering.
**Suggested** keeps the original compact palette. Results load 120 at a time
with **Show more icons**; rendering uses the OS emoji font, so newer emoji may
not be supported by older systems. Skin-tone variations are consolidated into
base emoji. No image CDN or network access is needed.

**None** explicitly clears a lane. **Auto** removes its override and returns to
the branch-derived marker; in Manual mode this action is labelled **Default**
and leaves the lane unmarked. Escape or Cancel leaves the choice unchanged.
Explicit choices persist across reloads and mode changes. The picker dims
markers other lanes on the same machine chose explicitly, in any workspace:
This Mac's lanes for a This Mac lane, that Host's lanes for a Host lane.

## PR status

Desktop's `apps/desktop/electron/fs/gh-cli.ts` and the Host's
`features/git/github.ts` bind one machine-owned reader from
`libs/session-runtime/src/git/github-reader.ts`. It runs **read-only** `gh`
queries: no push or PR creation, and no credentials in the renderer.

Discovery and status refresh are separate:

- The client derives relevant branches from existing Git/lane projections,
  prioritizes the active lane, then oldest attempted branches. Each page has
  at most 20 branches; a refresh tick handles at most four pages and publishes
  each as it arrives. Larger groups rotate through subsequent ticks.
- Discovery uses batched GraphQL `pullRequests(headRefName: ...)` aliases, not
  prefix searches or the repository's newest 100 PRs. It checks the head
  repository against the checkout's origin, so another fork's same-named branch
  cannot be attributed to this lane. Open PRs outrank terminal history. A
  truncated connection cannot prove absence.
- Once discovered, a PR is refreshed by its canonical repository and number.
  Branch discovery and repository identity are rechecked every five minutes,
  so reused branches and changed remotes can recover. Negative discoveries are
  retried after 60 seconds. Associations are an in-memory inference from the
  current checkout, not a persisted claim that this session created that PR.
- Details are fetched only for those PRs. A resource-limit failure retries once
  without details. Check contexts are capped at 100 per PR; truncated or omitted
  details stay unavailable, never a green checkmark. No checks also earns no
  passing glyph.

The machine cache coalesces in-flight work independently of freshness and
serializes upstream queries. Reads have a 20-second total budget including queue
wait, an 8-second subprocess limit, and cancellation. Successful branch reads
are reused for 60 seconds. Failures back off from one to 15 minutes; rate limits
honor retry/reset headers and pause the reader across repositories. Forced reads
respect backoff and a five-second minimum. Cache state is bounded to 64 recent
repositories and 1,000 branches per repository; the pending-read limit is 64.

`stores/pullRequests.ts` is keyed by **repo path**, not session: a sidebar
group is exactly one repo, because worktrees fold into their main checkout. A
lane's PR is joined at render time through its cwd's branch.

One shared refresh clock checks relevant repositories about every 60 seconds:
**visible expanded** groups, the visible Home board, and the active lane's own
repository even when its group or sidebar is collapsed. Closed, unrelated
workspaces are not polled. Lane activation, window focus/visibility resume,
disk/Host summary changes and active-agent settlement request stale reads.
Same-repo lane switches and concurrent consumers coalesce inside `PR_STALE_MS`;
there is never one request per row. The clock pauses while the document is
hidden and removes its timer/listeners when the last consumer leaves.

Each targeted reply includes per-branch coverage: found, absent or unavailable,
with upstream observation and attempt timestamps. Partial replies merge into
the store; an unavailable or unqueried branch keeps its previously known PR.
Only explicit absence removes it. Missing gh, auth, network and deadline failures
are normal unavailable states, without toasts. Desktop runs gh through
`piProcessEnv` for the login-shell PATH; the Host uses its own environment.

**Absence shows nothing.** A lane whose branch has no PR gets no chip and no
header pill; absent coverage only removes a previously known PR. A targeted
reply never claims repository-wide completeness.

Remote groups use the same store, keyed by opaque Host/repository identity.
`github.prs` requires `workspaces.read` and resolves only configured repository
ids, never client filesystem paths. Its optional `options` carries bounded branch
interests and a force flag. The existing 100-entry wire cap is unchanged; new
pages stay below it. Both Host and host-client validate coverage.

A new client retries without options only if an older Host rejects the additive
field with `bad-request`. Legacy Host reads retain the capped recent listing,
coalescing and a 20-second deadline. A failed supplemental legacy search returns
unavailable rather than replacing known results. Old replies without coverage
can prove absence only with `complete: true`. Native callers without branch
interests discover at most 20 local worktree heads. These compatibility paths do
not have the new targeted coverage guarantees. Desktop's local gh availability
has no bearing on remote PRs.

### Active-lane header

After the lane title, a lane with a PR gets a compact, keyboard-accessible PR
button with the same status mapping and colours as row chips. A lane without
one gets nothing there. It is a real button, not the sidebar's non-tabbable
link span, and respects the PR-status preference. Desktop keeps its 44px bar; phone and wide browser headers reuse the same control. Its details
show state, check counts, review decision and conflicts independently: green
checks do not imply approval. Identity-only results label those details unavailable.
Enter/Space opens details; Tab reaches Open on GitHub and Refresh; Escape closes
and restores focus. Errors opening GitHub are visible and retryable.

Refresh requests a forced read, subject to the machine reader's cooldown and
backoff. Details show the selected branch's last upstream observation and failed
attempt, explicitly labelling retained status as stale. Cached reads do not
advance upstream freshness. Older Hosts without coverage retain the separately
labelled app-refresh timestamp and cache warning. Loading and unavailable states
are explicit; a missing local gh probe is retried on a later attempt. There is no
history crawl or webhook guarantee.

### Slack thread links

After the PR button, a pill with Slack's colour mark lists the Slack threads the
lane has in context, so you can get back to them and point the agent at one. It
renders nothing until the transcript mentions a thread, and shows a count once
there are several. `LaneLinks.tsx` puts both controls in all three headers, and
both are one component, `LaneHeaderPill.tsx`, which owns the trigger, the
anchored popup, focus on open and focus return; only their contents differ.

The popup is the shared `PopupMenu` in its anchored mode (`escapeContainer`),
like `ChoiceMenu` and the machine header menu: portalled to `<body>` and placed by
floating-ui, so it fits beside a pill at the right edge of the wide browser header.
It can sit below the window for a frame before it is placed, which is harmless
only because [the window never scrolls](ui-shell.md#window--chrome).

`slackThread.ts` derives the list from the chat store on every render. Nothing is
persisted, so there is no IPC, Host protocol or session-file change, and sidebar
rows do not carry it. Only user prompts and settled assistant text count; tool
output (a Slack search through MCP) and a still-streaming reply do not. Each item
is parsed once (a `WeakMap` keyed by the immutable item). Threads are deduplicated
by channel and thread root, so a reply link and its root are one entry, in the
order the transcript first mentions them. Each row shows the workspace, the
thread's start time and the message that mentioned it, links removed.

A link counts only when `new URL` parses it as `https:` on `slack.com` or a
`*.slack.com` subdomain with no credentials or port, and its path is a message
permalink (`/archives/<C|G|D id>/p<16 digits>`, with an optional valid
`thread_ts`) or the web client's `/client/<T id>/<C id>/thread/<C id>-<ts>`. The
URL that is opened or copied is rebuilt from those parsed parts, never the pasted
text, so extra query strings and fragments are dropped.

A row opens the thread through `app:openExternal`; the Slack desktop app takes
over an https permalink if it is installed. Its trailing actions copy the link,
or add it to the lane's unsent message (`composerDraftKey`, never replacing what
is typed) and focus the composer. Opening and copying failures are shown in the
popup, which stays open so you can try again. Enter/Space opens, focus starts on
the first thread, and Escape closes and returns focus to the pill.

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

A local lane is named once, after its first turn ends, by a one-shot `pi -p` call
(`apps/desktop/electron/pi/session-title.ts`). The title flows to the branch as well as the
session, so the sidebar group, the branch chip and the title agree. Desktop and
the Host share one policy (`libs/session-runtime/src/pi/title-policy.ts`: argv,
attempts, model pick, prompt, sanitizing, dedupe) and one runner
(`libs/session-runtime/src/pi/title-run.ts`) on `runPrintMode`; each injects its
env, catalogue and limits ([host.md](host.md#remote-lane-names-and-lifecycle)).

A title is 2-5 words and at most 60 characters on every machine; neither is a
preference. The prompt lists up to 40 existing titles in the repository, worktrees
included, and a reply that still collides gets a numeric suffix (`dedupeTitle`),
with the title shortened so the suffix stays within the 60 characters.

Two naming passes never run for one session: `startChat` owns naming for the
chats it creates and suppresses the session store's own pass.

`titleArgs` strips everything a title does not need (tools, context files,
skills, prompt templates) so the call is not carrying ~35,000 tokens of harness
to produce a 15-token title, and always passes `--thinking off` (a title on
Haiku at the inherited `high` took 6.0s, against 2.8s off).

The model is the cheapest one in the default's provider, family and region
prefix with a known price below the default's (`pickTitleModel`, from the
cached model catalogue): Opus on the Claude CLI names with the cheapest Haiku,
`kimi-k2` with `kimi-k2-turbo`. Unpriced catalogues (local models) and an
already-cheapest default keep the default. On the Claude CLI with no catalogue
it falls back to `claude-haiku-4-5`.

The run boots fast with `--no-extensions`, so no installed package (MCP
adapter, sub-agents, web access) starts for a title. Providers can register
through extensions, so a fast boot loads the provider's own extension
(pi-claude-cli's, resolved from the installed package with `resolvePackagePaths`).
An empty extension resolution skips the fast attempt rather than passing package
display names as executable paths. If a fast boot fails, the same model runs
on a full boot, then the fallback model; a provider or model that needed the
retry is remembered until the app quits. Measured on the Claude CLI: 2.4s from
spawn to title, against 6.0s before. The run is spawned as its own process
group, and the whole group is killed when it finishes, so nothing it started
(the Claude CLI, an MCP server) outlives it.

Two constraints on the one-shot, both silent when broken:

- `pi -p` blocks until stdin reaches EOF, so it never runs through `execFile`.
  See `apps/desktop/electron/pi/print-mode.ts`.
- pi-claude-cli ≥ 0.7.0 parks its CLI process after a turn, which holds pi's
  event loop open, so a naming run would print its title and then not exit for
  ten minutes. The naming env passes `claudeOneShotEnv()`
  (`PI_CLAUDE_CLI_KEEPALIVE_MS=0`) through `titleRunEnv`, which also pins
  `PI_CLAUDE_CLI_CONTEXT=pi` as sessions do. On Desktop the runner also titles
  from whatever stdout arrived before a timeout or abort (`acceptPartial`), so a
  slow exit cannot throw away a finished title; a Host discards that output.

## Preferences

`LanePrefs` in `AppPrefs.lanes`, edited in Settings → Lanes, a device section: it
shows whichever machine Configure chooses, and the browser keeps it too
(browser-local, [web client](web-client.md#memory-and-offline-behavior)). The
prefix and slug length name a Host lane's branch as they do This Mac's, and
markers and PR status apply to every machine's rows. Automatic naming is the
machine's, under Settings → Agent.

| pref                  | default | reaches                              |
| --------------------- | ------- | ------------------------------------ |
| `markers`             | `auto`  | the sidebar row                      |
| `prStatus`            | `true`  | the row's PR chip                    |
| `autoName`            | `true`  | both naming passes                   |
| `branchSlugMaxLength` | 40      | `slugifyTitle`, so branch and folder |

The branch **prefix** is separate, in `WorktreePrefs.branchPrefix`, beside the
switch that decides whether a chat gets a branch at all. `WorktreePrefs`
decides _whether_ a lane gets a branch; `LanePrefs` decides what it _looks
like_. Worktrees off still names sessions.

**The slug length is clamped twice**, in the renderer and in main. It reaches a
git ref and a filesystem path, and the settings UI reads back the value it just
wrote, so an out-of-range entry must be corrected locally too. Stored prefs from
older builds may still hold `nameMinWords`, `nameMaxWords` and `nameMaxLength`;
`normalizeLanePrefs` drops them.

`LanePrefs` lives in its own leaf store (`stores/lanePrefs.ts`), not in
`stores/settings.ts`, which calls `window.matchMedia` at creation and would
break every non-jsdom suite that touches sessions.

## Switching lanes

Only a lane that is already live switches instantly. Every other lane has to
spawn a pi process and replay its transcript first, and a new lane has to cut a
branch before that. Two rules cover the wait.

**The click is acknowledged before the process exists.** `openDiskSession`
records the lane in `sessions.opening` synchronously, so on the same frame the
sidebar row highlights and says `Opening`, and `OpeningLane` covers the main
region with the lane's title. It is an overlay, not a fourth state of the main
region, so the previous lane keeps its React tree and a failed open leaves the
user exactly where they were. Clicking a lane whose open is already running
still activates it rather than deduping to nothing.

**Whatever finishes last does not win.** `sessions.navSeq` counts explicit
navigations — a click, a palette entry, a send. Every step that would put a
lane on screen carries the navigation it belongs to and checks it first:
`createSession` activates only for a current claim, `startChat` takes its claim
at the keystroke (not several seconds of git later) and skips re-pointing the
window at the new worktree once the claim is stale.

So sending a message to create a lane and then switching away to work in
parallel now sticks. The new lane still gets its branch, its process, its
generated name and its branch rename, in the background, and says so with a
lane notice instead of stealing the screen back twice. Clicking the notice goes
there.

**A lane that finishes off screen says so.** When pi reports a lane's run
settled (`agent_settled` after an `agent_start`, in the push handler) and that
lane is not in front of you, `noticeLaneSettled` puts up a notice with the
first line of the final reply, or the error if the run stopped on one. A run
pi reports `aborted` says nothing: only the stop control produces one. A lane is
in front of you when it is on screen in a focused window (`laneInView`): it gets
no notice, since its transcript already shows it. On screen in a background
window it does. A Host lane's attention follows the same rule through the same
presenter (`noticeHostAttention`): the same wording (`settledNotice` from the
run's receipt, with its excerpt, for a finished or failed run and a finished
routine; “Needs your input.” for a question; a neutral “Routine update.” for a
routine with no receipt, which may have paused), kind and marker, titled with
its machine.

**The wait is animated, not flashed.** `OpeningLane` fades in after a 90ms
beat, so opening a warm lane never flashes it, and fades out over the lane it
revealed (`useLingering` keeps it mounted for the exit). A transcript rises in
on every mount — a lane switch, or the skeleton giving way to history — and the
skeleton carries the Phosphor beacon instead of a spinner.

The same claim is what lets a lane **restart** in place. `restartSession`
disposes pi and resumes from the same session file, which is how a provider
change (`ModelPicker`) and a Claude account change (`moveSessionToAccount`)
take effect — disposing clears `activeSessionId`, so without this the user
dropped to the greeting screen for the whole window. On screen it is
`OpeningLane` with `reason: 'restart'`; the model chip reads
`Switching to <model>…` and is inert until it settles. A restart of a lane the
user is **not** looking at never takes the screen.

## Finding a lane

A magnifier in the workspace header opens a search field **under** that
header. It filters that group only: search is per project because the header
it hangs off is. This Mac's groups and Host folders are one group shell
(`LaneGroup.tsx`) with one search (`useGroupSearch`), so a Host folder's search
is the same, through the same matcher.

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

One Host lane row (`features/sessions/RemoteLaneRow`) and one menu serve every
surface: Desktop's sidebar, the browser's navigation and Lanes page, Host home and the
machine preview. `laneActions` builds the menu as a pure list in This Mac's
order and labels, from the context `hostLaneContext` maps (Open, Move up and
Move down where the row sits in an ordered list, Rename…, Make routine…, Pin,
Lane marker…, Open pull request when the lane has one, Take or Release control,
Stop or Resume, Mark read on an unseen lane, then Export HTML…, Copy debug
info and Copy spend, then Delete), and `useRemoteLaneActions` runs it; the
phone's lane sheet lists the same items without Open. Absent data hides an
item; a refusal disables it and names itself. The row's menu opens on right-click, the ContextMenu key or
Shift+F10, and a touch long-press; on a phone it is a bottom sheet. The row
renames inline, the sheet through a prompt. Opening a row navigates to the lane
without naming a pane, so Desktop restores that lane's pane and the browser opens
Chat. The title prefers the live session name, the Host summary, then the first
prompt. The Host, not Desktop, generates remote titles.

Pins and markers belong to the Host: a Host that announces `laneMarks` keeps
them, so every client shows the same ones
([protocol](remote-protocol.md#lane-pins-and-markers)); Desktop's older local
choices, kept under Host/lane resource keys, move to it, and rows read only the
Host's. A Host lane with no explicit marker shows the one derived from its
branch, and `LanePrefs.markers` applies as on This Mac: `manual` derives
nothing and `off` removes the slot and Lane marker. Without `laneMarks`, Pin
and Lane marker are disabled with “Update this
Host to pin and mark lanes.” A pinned Host lane shows the pin icon and sits in a
Pinned section above that Host's folders, newest first until you reorder them
([Remote Desktop](remote-desktop.md)), with its folder named, as local pinned
lanes sit above local groups. Pins stay per Host: one Host's
pinned lanes never mix with another's or with local ones.

Copy debug info writes This Mac's block (`formatSessionDebugInfo`: pi's id and
model once the lane is open) with the machine, Host, lane and branch in place of
paths: no Host path reaches the clipboard. Copy spend copies the formatted cost,
as This Mac's does. Both copies confirm with a toast and, where the clipboard is
denied, show the text to copy by hand, on either machine. Export HTML… opens the lane's session if needed and saves the Host's export
(`exportRemoteLaneHtml`): a save dialog on Desktop, a download in the browser.
Local-only tree, fork and clone actions are omitted.
Remote Delete needs control and workspace-write capability, in Desktop and the
browser alike. A disabled action's hint names its obstacle: “Take control
first.” for a viewer, “Only while running.” for rename and spend on a stopped
lane, “Send a first message before stopping this lane.” for Stop on an open lane
with no first message (the Host refuses it), and “This Host does not offer lane
control to this device.” (or file editing, for Delete; routines, for Make
routine…) when a ready Host does not grant the capability. Delete uses the
same resource confirmation, keeps failures visible, and closes the lane on
success. A shared worktree gets transcript-only deletion. The Host keeps trashed
transcripts for 30 days; worktree removal and merged-branch deletion are optional.

Every sidebar session has **Delete**, including starting, running, crashed and
live-only rows whose transcript is missing. A row that is the **only session
in its own worktree** opens the lane confirm below, with worktree removal on
by default — deleting just the transcript used to leave the directory, and its
`node_modules`, on disk with nothing in the sidebar pointing at it. Every other
row (the main checkout, a shared worktree, no git info yet) gets the
session-only confirm: running work will stop, saved transcripts are trashed,
and the worktree, branch and project files are kept. A missing transcript is
not an error; other failures stay visible in the confirmation so deletion can
be retried. Pending rows do not invent a timestamp from the current time.

Concurrent opens of the same transcript share one process. Main serializes
resume and deletion by transcript path, cancels queued or hung startup opens,
and stops every matching writer (including
handles not yet adopted by the renderer), then trashes the file. Deleting a
routine-owned lane cancels its run through the scheduler first. Processes own
their child process group so nested provider processes are stopped too.
Late bootstrap responses cannot recreate deleted renderer state. On reload,
main supplies known file identities; history replay does not block access to
an unresponsive lane's Delete action.

Selection is scoped to **one group**, which is one repo, on This Mac and on
every Host: `laneSelection.ts` holds one selection at a time, so selecting in
another group starts over. A destructive confirm spanning two repos is how you
delete the wrong branch. The Pinned list mixes projects and is not selectable.
Each group on screen holds its own claim on that selection (`useGroupSelection`),
so a folder shown in two lists at once keeps a selection to the list that made it.

The checkbox replaces the indicator dot in the same gutter, so entering select
mode shifts nothing (`SelectableIndicator` in `LaneSelect.tsx`, on both lists).
"Select all lanes", "Select merged lanes" (lanes whose pull request merged)
and "Collapse lanes" live in the workspace `⋯` menu (`LaneGroupOptions`), above
the machine's own folder rows, on This Mac's groups and Host folders. The bulk bar
(`LaneBulkBar`) shows only in select mode.

Deleting is three resources, and all three default on. The branch default is
safe because an unmerged branch is never deleted:

1. the session transcript, to the OS Trash (recoverable): pi's `.jsonl`
   **and**, for a session recorded before provider 0.9.0, its paired Claude
   Code transcript with its `<id>/` sidecar folder (subagent transcripts,
   oversized tool results); current Claude sessions write neither. The
   bookkeeping nothing reads once the session is gone is removed with it: `pi-claude-cli`'s
   session-map entry and stored system prompt, and pi's per-cwd session folder
   once it is empty (`apps/desktop/electron/pi/session-deleter.ts`)
2. the worktree directory, gone
3. the branch, only when its work is already on the trunk

**A worktree goes only with the last session using it**
(`lanesOwningWorktree`). One directory can hold several sessions. A worktree
is offered for removal only when every session in it is being deleted, and it
is removed with the last of them — the loop is sequential, so the others'
transcripts are already in the Trash. A live session with no transcript yet
counts as a user and holds the worktree.

**A branch is deleted only when it is proven landed.** `git branch -d` tests
ancestry, and a squash merge leaves no ancestry link, so `-d` refuses every
squash-merged lane. Either of two proofs about the tip the caller read is
enough, and the branch goes only when one holds, by one compare-and-delete at
that tip (`deleteBranchAtTip`, `git update-ref --no-deref -d <ref> <tip>`). A
branch that gained a commit during the proof, or that a worktree has checked
out, is kept. This Mac and a Host share the proofs and the deletion
(`libs/session-runtime/src/git/branch-landed.ts`). Each machine composes them
over its own trunk rule: This Mac's `isBranchLanded`
(`apps/desktop/electron/fs/git-worktrees.ts`) against `origin/<default>` and
`<default>`, the Host's `branchLanded` (`apps/host/src/lanes/delete.ts`)
against the trunk lane creation used.

- **The squash test** (`landedOnTrunk`): ancestry, else `git cherry` against a
  commit built from the branch's tree.
- **A merged PR** (`landedViaPullRequest`, asking GitHub through
  `githubEvidence` and `gh`): the squash test misses a lane whose history was
  rewritten after merging, or whose squash was cut on a newer trunk. It proved
  2 of 26 merged lanes on one install. A merged PR from the branch counts only
  if the local tip is its head, sits behind it, or has the same tree, so a
  reused branch name or work added after the merge never passes. Without
  `gh`, or offline, this proof answers no. A Host asks its own `gh`, each
  question with an 8 s timeout, and starts none after a proof's first 20
  seconds.

Anything unproven is kept and reported; the transcript still goes.

**Remote branch deletion is not offered.** A bulk flow is the worst place to
introduce the least reversible operation.

### Lost-work acknowledgement

Running turns are included, not refused. A turn in progress, uncommitted
changes, unpushed commits, or an open PR raises **one** acknowledgement for the
whole selection. Confirming stops those turns before deleting their lanes.
A disposal failure is reported per lane and does not strand the progress loop.

### Ordering, and why it is that way

Per lane: dispose the live session, remove the worktree, then delete the
transcript. Worktree removal is the step that fails in practice (a terminal
cwd'd into it, a dirty tree), and failing first leaves the lane whole and still
in the sidebar. The other order leaves a transcript in the Trash and a
directory on disk.

The loop is **sequential**: each lane disposes a subprocess and runs git, and N
at once is how a worktree gets removed while its own pi is still writing.
Cancellation is checked between lanes only.

### Deletion stays out of the way

After the destructive confirmation, progress moves to a compact notification
at the top left. It has no backdrop, so the rest of Phosphor remains usable.
The lanes owned by the delete loop are disabled until they are removed, fail,
or are skipped after Stop; other lanes and the active workspace remain usable.
A second bulk delete cannot start while the first one is running.

The notification expands to show every per-lane outcome. That detail matters:
a worktree that would not remove is the common case, and that lane remains in
the sidebar. When processing finishes, the panel collapses to its summary,
then fades away.

## Reclaiming lanes automatically

A merged PR finishes code, not a conversation. Automatic cleanup requires an
explicit **Finish conversation…** decision from the sidebar context menu for
**every** transcript in the checkout. Stop its live sessions first. **Reopen
conversation** or resuming the lane clears that decision. Unknown, legacy,
paused and otherwise unfinished conversations remain protected across restarts.

Settings → Advanced → **Maintenance** runs a sweep with two switches, because
measuring and deleting are different risks:

- **Reclaim dead lanes** (on) sweeps hourly and **reports**. It never deletes.
- **Delete automatically** (off) lets a sweep act.

**Reclaim now** deletes without flipping the pref and cannot delete more than a
sweep would; both run the same policy. Scan, **Reclaim now** and the scheduled
sweep all cover every workspace in the recent-workspace list, one after
another, and the section lists what each one could free. (The button once
covered only the active workspace, so one click freed one repo and silently
left the rest.)

All conditions must hold before a worktree is a candidate
(`apps/desktop/electron/maintenance/policy.ts`): not the main checkout, on a
branch, verifiably clean, not protected by a live session, recent workspace or
routine, not Git-locked or pinned, **all conversations explicitly finished**,
**proven landed**, and past `minAgeHours`. Empty or unreadable histories do not
count as completed. Git ancestry can prove a research branch landed, but never
proves its conversation finished. Existing opt-in preferences and **Reclaim
now** do not bypass completion. Every rejection is reported with its reason.
The PR proof runs only for clean lanes Git could not prove, four `gh` calls at
a time.

Before each removal, main takes the same workspace gate as Desktop session
admission and rechecks eligibility, current ownership/protection, completion,
activity, locks and dirty state. A queued resume invalidates completion before
waiting for the gate. These ownership protections are process-local; an external
pi process is not registered here. Git worktree locks remain a protection across
processes and are never forced through.

Manual **Remove worktree** is a separate explicit action: it previews affected
conversations and requires confirmation, refuses live ownership and locks, and
requires a second acknowledgment to discard dirty files. History is retained.

A recent workspace that is not a git repository (a "No folder" sandbox) is
skipped, not reported as a sweep error.

The grace period starts from the later of explicit completion and real activity:
actual transcript-file modification times, persisted session-open/seen times,
and checkout/session-directory timestamps. Appending a transcript need not
change its directory mtime, so directory timestamps alone are not sufficient.

Before removal, main saves repository, checkout path, branch, exact tip commit,
related conversation IDs, completion/activity timestamps, eligibility reason and
attempt outcome in `userData/session-maintenance.json`. A Git ref under
`refs/phosphor/recovery/` keeps that tip reachable even after branch deletion.
A crash after recording intent leaves a `pending` audit record, not lost identity.
These records and refs are retained; cleanup does not age them out.

Sidebar discovery also reads retained transcript headers under each repo's
`.phosphor/worktrees/`, independent of surviving Git registrations, plus saved
removal records for other checkout locations. Removed checkouts show **worktree
removed**; clicking one opens a read-only saved conversation, without restoring
files, starting pi, changing completion or rewriting the transcript's cwd. Failed
reads offer Retry. The saved active context includes pi's compaction summaries;
the session tree remains available separately.

**Restore worktree…** (the row's context menu, or the reader's footer, which
also resumes the conversation afterwards) opens a chooser
(`maintenance/recovery.ts`). Every option recreates the **original path**, so
the transcript and the Claude provider's cwd-keyed ledger stay untouched; moving
a conversation to a new folder would mean rewriting both. Options, most exact
first, and only those that apply:

- **Restore saved commit**: the exact saved commit, detached to avoid
  overwriting a reused branch. Needs a removal record.
- **Check out `<branch>`**: one branch, local or on origin only, that matches
  the checkout: the branch in a stale Git registration or the removal record,
  else the single branch named `<folder>` or `…/<folder>`, with the configured
  prefix breaking a tie. Several candidates mean no guess. Trunk and branches
  checked out elsewhere are never offered.
- **New branch from `<trunk>`**: `<prefix><folder>` (suffixed when taken) cut
  from the start point new lanes use. It does not bring back the lane's earlier
  work, and the chooser says so.

The chooser lists the files the conversation's `edit`/`write` calls changed in
the old checkout, or states that there were none. Shell commands are not
checked, so an empty list is a hint, not proof. Main recomputes the plan inside
the workspace gate when an option is picked, refuses an existing path, a live
session, a locked registration and paths outside `.phosphor/worktrees/`, and
drops a stale Git registration of that same path first (other stale entries
are left alone). Dependencies must be
reinstalled. Phosphor never picks a replacement silently.

Sizes come from `du`, which Windows lacks; an unmeasured size reports "unknown"
and the policy never depends on the number. The scheduler is a plain interval
in main with a 5-minute warmup and a 15-minute floor, one sweep at a time.
