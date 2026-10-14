# 03 — App Shell, Workspaces, Panes

## Window & chrome

- Frameless everywhere: `hiddenInset` traffic lights on macOS, a theme-matched
  `titleBarOverlay` for the Windows/Linux window buttons. **There is no
  application menu**, so every command reaches you through the top bar, the
  command palette or a key binding. Chromium's zoom accelerators are
  re-implemented by hand in `useGlobalShortcuts.ts`.
- Window title: `<project> — Phosphor`, or `<repo> (<branch>) — Phosphor` for
  a worktree; plain `Phosphor` before a workspace is open. The session name is
  deliberately absent: the OS title names the folder, and the session already
  owns the top bar and the sidebar row.
- Global shortcuts: Cmd/Ctrl+N home screen (clears the active session; folder
  and first prompt are chosen there), Cmd/Ctrl+P fuzzy file finder, Cmd/Ctrl+F
  find and Cmd/Ctrl+Shift+F search in files ([Find](#pane-system)), Cmd/Ctrl+,
  settings, Cmd/Ctrl+backtick terminal pane, Cmd/Ctrl+Shift+E files pane,
  Cmd/Ctrl+Shift+G changes pane, Cmd/Ctrl+B sidebar, Cmd/Ctrl+/ the shortcut
  list, Cmd/Ctrl+plus / minus / 0 UI scale. Punctuation bindings match on
  `event.code`, so shifted and non-US layouts still hit them. The full sheet,
  including the chords inherited from Claude Code (Esc Esc rewind, ↑/↓ prompt
  history, Tab/Shift+Tab, Ctrl+O verbose output), is Settings → Keybindings.

**Shortcut scope:** New, Find, Files and Changes work from the composer.
Go to file also works from the editor and ordinary text fields; Ctrl+P remains
shell history in terminals. Search in files works from any focus, the editor included.
F6 moves between the composer and pane controls; in a fullscreen pane it
focuses Exit fullscreen. Dialogs block app navigation (not zoom). IME/AltGr and
editor-owned letter chords are never read as app commands. Bindings belong to
the app document, not to artifact iframe contents.

### Top bar

One **full-width bar** (`apps/desktop/src/app/TopBar.tsx`) above the sidebar, chat and
pane columns: sidebar toggle, workspace chip, branch control
([worktrees.md](worktrees.md)), session title, the pane switches (terminal,
files, changes, artifacts, subagents) and the session kebab. The terminal switch carries a
tab count and a running-process dot; the artifacts switch appears once the
session has an artifact, with a count and an unseen dot.

Everything right of the sidebar toggle is **session-only**. On the home screen
the bar keeps its height and renders nothing else, because that screen puts the
same folder and branch controls above its composer, where choosing them is the
point. Two folder chips on one screen is two answers to one question.

It is the **only** element allowed in the strip the OS draws window controls
in, and so the only call site of `.titlebar-inset-end` / `.titlebar-inset-start`.
Those insets are `100vw`-relative and only correct on an element that spans the
window. Columns must not grow their own title bars.

## Startup

A full-window loading screen uses the saved appearance from the first paint,
then stays up while fonts, preferences, pi health, the previous
workspace/session transcript and the visible sidebar's first scan settle. The
shell mounts hidden beneath it so discovery finishes without skeletons or
stray shortcuts. Readiness dismisses it; there is no minimum display time.
Missing pi leads to setup; a startup failure offers retry; a failed restore can
be skipped. The model catalogue preloads in the background without holding the
screen.

## Left sidebar (Claude Desktop style)

Signed-in windows show a compact machine menu beneath the main navigation. Each
window starts on **This Mac**, and selection stays in memory only. Its right edge
summarizes activity on other machines; All machines has no “elsewhere” activity.
The menu supports arrow keys, Enter, Escape with focus return, and outside-click
dismissal. Add machine opens Machines with the existing add dialog.

This Mac keeps the local workspace groups unchanged. Hosts use the same group
header, lane row, indicator and subtitle primitives, grouped by configured
repository. Search commits on Enter; the group menu collapses lanes; + preselects
that repository in the remote creation dialog. Empty repositories show “No lanes
yet”. All machines puts local groups first, then machine-labelled Host groups.
Signed-out windows have no machine switcher or remote groups.

- **Workspace switcher** at top: current workspace plus a dropdown of recents;
  "Open Folder…" via the native picker.
- **A workspace is identified by its REAL path.** One folder reachable through
  a symlink — a linked checkout, a synced folder, a relocated data directory —
  is two path strings, and the sidebar keys groups by string, so it showed two
  headers for one folder, each listing the SAME lanes (pi derives its session
  directory from the resolved cwd, so both scanned it). Main therefore resolves
  a path at **every** point one enters (`realPathOrNull`, `apps/desktop/electron/store.ts`),
  and the renderer never sees an unresolved one — it has no filesystem and
  could not collapse them itself. All five matter:
  - the folder picker, so opening through a symlink cannot mint a spelling;
  - `recordWorkspace`, which stores resolved and drops **every** other entry
    for that folder — rewriting just the first match left the rest behind and
    could persist one path twice, which no de-duplication on read can undo;
  - `getPrefs`, which answers recents, `lastWorkspacePath` **and**
    `collapsedWorkspaces` under their resolved paths. Recents so Settings can
    tell a sandbox from an ordinary recent by string; the resume target
    because `openWorkspace` compares recents by exact string, and a stored
    spelling from an older build opened a second in-memory group for the whole
    launch; the collapse list because the sidebar looks a group's state up by
    its resolved key, and a choice stored under the other spelling was simply
    never consulted;
  - **session spawn**, which is the one that bites last: a live session's
    `workspacePath` is unioned into the sidebar's group list, so a session
    started under the other spelling put a second group back after recents
    had already been cleaned;
  - and the renderer's `createSession`, which must record the path **main
    answered with**, not the one it asked for. That entry is what
    `useActiveWorkspace` and the group list read, so keeping the request
    would undo the spawn-time resolution the moment it arrived.
- `resolveSandboxFolder` compares real paths for the same reason; a lexical
  compare refused a sandbox's own real path and silently disabled Delete and
  Rename for it.
- **A sandbox operation covers the folder's whole SUBTREE, never just the
  folder.** A sandbox that is a git repo has lanes under it, and a lane is its
  own cwd: its live session's `workspacePath` is a descendant of the sandbox,
  and its transcripts sit in their own directory named after the mangled lane
  path. An exact path compare therefore let a live lane through both the rename
  and the delete guard, and the transcript move covered only the root — so
  renaming a sandbox moved the folder out from under a running pi and orphaned
  every lane chat at once. Containment is `isWithinFolder` (`libs/shared/src/paths.ts`,
  shared because main guards on it and the renderer picks the chats to close
  with it), and the cwd list is `sandboxCwds` (`apps/desktop/electron/sandbox.ts`). That
  list is enumerated from DISK rather than by prefix-matching pi's mangled
  directory names: the mangling joins segments with `-` and folder names
  contain `-`, so `games` and `games-2` produce names one of which is a prefix
  of the other, and nothing can un-mangle them back apart.
- **A session's recorded cwd is a hint; the directory it was found in is the
  authority.** Each session file freezes the cwd pi ran in, and nothing
  rewrites history when the folder later moves — so renaming a sandbox moved
  its transcripts (they are still found) while every file inside kept naming
  the old folder, and the sidebar hands that value straight to `createSession`.
  Opening such a row spawned pi in a deleted directory, and the copied debug
  block named a Claude transcript that had moved. `listSessions`
  (`apps/desktop/electron/pi/session-scanner.ts`) therefore substitutes the folder it
  scanned whenever the recorded one is **gone** or is a second spelling of the
  same folder, and leaves it alone when it names a different folder that still
  exists — both are real, and guessing would be worse than reporting. This is
  retroactive by construction: a folder renamed by an older build is corrected
  on the next scan, with no migration.
- **Substituting the cwd is not enough on its own — the file has to be
  repaired too.** pi reads the stored cwd back out of the session header and
  refuses to resume when it no longer exists, printing
  `Stored session working directory does not exist` and exiting 1 before the
  RPC loop starts (its `core/session-cwd.ts`; only interactive mode offers the
  "continue in current cwd" prompt, and no flag answers it up front). So a
  renamed sandbox listed all its chats, handed pi the right `cwd`, and every
  one of them still died on click with nothing on the chat to say why.
  `apps/desktop/electron/pi/session-cwd.ts` rewrites the header: `app:renameSandbox` does it
  for the whole subtree as part of the rename, and `spawnSession` repeats it on
  resume for anything the rename never covered — a sandbox renamed by an older
  build, or a folder moved in Finder. The resume-time pass fires only when the
  stored cwd is genuinely absent and the replacement genuinely exists, so an
  unmounted volume is left alone rather than rewritten somewhere else. A
  fork's `parentSession` moves with it, since that path contains the parent's
  own mangled cwd.
- **Flat nav rows**: `New`, `Artifacts`, `Skills`, `Routines`, `Machines`. `New` routes to the home
  screen; it does not spawn a session, because the folder and the first prompt
  are chosen there. Artifacts, Skills, and Routines open global pages (below).
- **Session list**: pinned, then sessions grouped by project. Each row: name
  (or first-message preview), relative time, state. Drag a row above or below
  another in its section to reorder it, or use its context menu's **Move up /
  Move down** or **Alt+↑ / Alt+↓** while focused. Open, suspended and closed
  sessions share one order, persisted by session file path across restarts.
  First-turn rows become reorderable once pi reports their file path, without
  waiting for the transcript scan. New sessions appear above the saved order.
  Pinned sessions reorder within Pinned; dragging never changes a session's
  project, pin state or running process. Search and multi-select temporarily
  disable reordering. A thin accent insertion line marks the drop position;
  rows stay still until drop, the list scrolls near its edges, and Escape
  cancels without saving.
  Starting/working lanes use the shared
  [Phosphor Beacon](style-guide.md#loading-identity--phosphor-beacon), an amber
  edge rail and a status chip in place of the timestamp. Context menu: open,
  session tree, pin, lane marker, open pull request (when the lane has one;
  this is the keyboard route, the chip is mouse-only), suspend (live lanes,
  labelled with the ~200 MB it reclaims), fork, clone, export HTML, copy debug
  info, copy spend, delete (trash). Live-only rows offer Open, Rename, Export
  HTML and Delete, even before a transcript exists. Delete confirms that any
  running turn will stop; failures remain visible for retry.
- **Per-workspace lane search**: a magnifier in each group header. See
  [lanes.md](lanes.md#finding-a-lane).
- **Group header toolbar**, always visible: the magnifier, a kebab, and `+`
  for a new session in that folder. The kebab holds Select all / Clear
  selection, **Move up / Move down** (this is where recents are reordered) and,
  for a project folder, **Remove from sidebar** (behind a second click that
  says files stay on disk). For a sandbox it holds Rename sandbox and Delete
  sandbox (the latter behind a second click) instead. A project folder is only
  ever _forgotten_, here or from Settings → Workspaces; renaming is offered
  for a sandbox because the folder is Phosphor's own. Rename closes the
  sandbox's running chats first and says so in the prompt; see
  [settings.md](settings.md#workspaces) for what a rename moves and what
  removing a project does.
- **Loading states per group**: never attempted → skeleton rows; partly
  scanned → the rows we have plus `loading N more folders…`; errored →
  "Couldn't load sessions" with Retry. A group is the main repo plus every lane
  under `<repo>/.phosphor/worktrees/`, folded in. An expanded group scans all of
  them; the 8-workspace cold-boot cap governs collapsed ones.
- Footer: the **update pill** above the account row. Silent unless there is something
  to act on ([updates.md](updates.md)). Version and platform are in Settings →
  About.
- **Account row**: a 28 px avatar, name and GitHub login when signed in, or
  a neutral avatar and Sign in when signed out. Its popover opens above the
  row. Signed in, it shows a 40 px avatar, name, login and email, Machines
  with an online count, Settings with its shortcut, and Sign out. Signed out,
  it offers optional GitHub sign-in and Settings. Signing in shows browser
  progress and Cancel. The gear opens Settings directly. Keyboard navigation,
  Escape and outside-click dismissal return focus to the row. No token reaches
  this UI ([settings.md](settings.md#phosphor-account)). Send feedback lives
  in the Settings footer ([feedback.md](feedback.md)).
- Collapsible (Cmd/Ctrl+B), width-draggable.

## Pane system

The main area is the chat plus **one float pane**, split by a drag handle and
persisted per session (selection, side, split size, fullscreen; localStorage,
pruned on dispose). The float region hosts exactly one pane at a time
(`RightPane = 'files' | 'changes' | 'terminal' | 'artifacts' | 'subagents' | null`,
`apps/desktop/src/stores/layout.ts`), opened from the top bar's switches, the command
palette or the shortcuts above.

1. **Chat pane** — always present ([chat.md](chat.md)).
2. **Files pane** — explorer tree plus Monaco tabs ([files.md](files.md)),
   itself split by a second handle. Opening a file from the tree, a chat chip or
   a diff lands here.
3. **Changes pane** — the working tree's modified files and their diffs. Files
   and Changes are two views of one "working tree" surface, so they share a
   segmented switcher in the pane header.
4. **Terminal pane** — tabbed terminals ([terminal.md](terminal.md)).
5. **Artifacts pane** — gallery plus viewer
   ([extensions.md](extensions.md#the-artifact-tools-and-what-each-one-costs)).
   Opens itself on a session's **first** artifact, and only when that session
   has no pane open already. A background session never yanks the foreground
   pane, and a new version never steals selection from an artifact you are
   reading. A resumed session's pane fills from the artifact store
   ([extensions.md](extensions.md#the-artifact-store)), so artifacts that
   compaction or a provider switch dropped from pi's context still show; it
   falls back to replaying `get_messages` if the store fails. The
   cross-session index is the global Artifacts _page_, below.

6. **Subagents pane** — a stable run/child navigator and independently scrolling
   read-only activity preview ([chat.md](chat.md#sub-agents)). The top bar,
   command palette, current-work summary and notice links all open this same
   session pane. The summary combines foreground/background evidence and remains
   visible while another pane is open; the top-bar badge mirrors its count and
   attention/unavailable signal. Narrow panes show the list or selected detail with Back to runs;
   wide panes show both. Its controls reuse `PaneShell`, including side swap,
   fullscreen and close.

The artifacts toolbar carries **two exports that are not the same thing**, and
they no longer share a glyph: a tray saves the _source_ through a dialog, a page
prints the _preview_ to a PDF in Downloads. The PDF prints what the preview
renders, so it returns to the Preview tab and waits for an async render first,
and it toasts either way — a silent success reads as a dead button.

**Find** has one bar and one set of toggles, and each surface points it at its
own text:

- **Cmd/Ctrl+F** opens find in the innermost surface around focus, or around
  the last click when that click landed on something that does not take focus,
  such as most of a rendered artifact (`components/search/findTargets.ts`).
  Anywhere else it opens the transcript's bar
  ([chat.md](chat.md#find-in-a-session)). Monaco and the terminal keep their
  own find.
- **In an artifact**, find searches the rendered preview of markdown, code and
  Mermaid diagrams. HTML and SVG previews are sandboxed iframes it cannot
  reach, and a chart is a canvas, so for those it switches to the Code view.
  The diff is Monaco, which has its own find. Moving to one of those views
  with the bar open says it cannot search there, next to a Switch to Code
  button. A model rewriting the artifact while the bar is open re-counts and
  keeps your place in the count (the third match stays the third), without
  scrolling.
- **Cmd/Ctrl+Shift+F** searches the workspace's files from any focus,
  including the editor and composer. It opens the Files pane on its search
  panel ([files.md](files.md#search-in-files)).

Rules:

- Drag-to-resize at 60fps. Dragging is the only gesture; there is no
  double-click-to-reset.
- Layout persists **per session**, so lanes keep independent arrangements
  across switches and restarts. Default: chat 55% / pane 45%, pane on the
  right. The Files pane's inner tree/editor split is per **workspace**, since
  that ratio is a property of the project, not the lane.
- The float pane can swap sides with the chat (⇄ in the pane header).
- Fullscreen (↗) overlays the main region (sidebar and top bar stay) and never
  resizes the split underneath, so exiting restores the exact prior layout.
  A stable portal container moves between the split and fullscreen slots;
  docking and fullscreen do not remount pane contents or discard drafts,
  disclosures, pending actions or reading position.
- Sessions in a workspace run **concurrently**. The chat shows the active one;
  switching between live lanes is instant; background sessions keep streaming
  into their stores. A lane whose process is not up yet has to be spawned and
  replayed first, and that wait gets its own overlay — see
  [lanes.md](lanes.md#switching-lanes).

**Changes navigation:** each file has a keyboard-operable Open button, separate
from Revert. A diff opens with focus on its Back button, and returning restores
focus to the originating row. Diffs use the editor's saved font.

## Theming

Light / Dark / System in settings. Tokens are CSS variables consumed by
Tailwind; surfaces that take a theme object (Monaco, xterm, Mermaid, Chart)
each carry a mirrored copy, listed in [style-guide.md](style-guide.md#color).
All switch together, live, no reload.

## Action tooltips

`components/Tooltip.tsx` owns action hints across the renderer. One
`TooltipProvider` wraps startup and the app, including portalled menus and
modals. `TooltipButton` is an unstyled native button with the existing refs,
events, and disabled semantics; the shared form, pane, composer, copy, and menu
controls use it. It consumes legacy `title` props instead of emitting native
browser tooltips, preserving descriptive information for assistive technology.
Text actions reuse their supplied React labels. Icon actions supply a name;
complex rows can supply an explicit `tooltip` string or structured `ActionHint`.
`TooltipLabel` and `TooltipSummary` retain native label/disclosure semantics.
Other custom targets use `tooltipProps()` or an explicit `data-tooltip`.

The host reads only those opt-in attributes, not DOM text or native titles.
It shares one pending opening and one visible bubble per window; Floating UI positions it
above the target and flips/shifts at viewport edges. Positioning observers exist
only while a hint is open. A source-contract test prevents new raw buttons and
native tooltip titles; iframe titles remain accessible frame names. Third-party
editor UI, native menus, terminal contents, and sandboxed HTML are not modified.

Hover waits 650ms for every target. Leaving early cancels it; leaving a shown
hint's target closes it after a 100ms grace. The bubble is click-through, so a
hint that overlaps a neighbouring control never intercepts its click.
Keyboard navigation shows hints immediately without moving focus, while mouse
clicks and touch do not. Existing active-descendant pickers retain their input
focus and option descriptions, rather than popping hints over the typing area.
Click, scrolling, typing, focus loss, target removal/change, and window
deactivation dismiss hints. A dismissed hint stays dismissed until a fresh
entry/focus. Expanded menu triggers can set `data-tooltip-open` to suppress hints.
Escape dismisses a visible hint before its menu/modal or a running turn, through
the existing depth-aware Escape coordinator. Hints contain no interactive content.
The visual recipe lives in [style-guide.md](style-guide.md#action-hints).

## Global surfaces

- **Global pages** — Artifacts, Skills, and Routines (sidebar rows). Full-main-region
  overlays belonging to no session, so they work from the home screen; any
  session activation closes them. Skills lives only here: browse, create,
  import/export and install into pi's global or project roots. The Artifacts
  page lists every artifact in the artifact store, from open, closed and
  deleted sessions. Forks that still share a version fold into one row,
  preferring an open session. Opening one jumps to its session with the pane
  on it, resuming a closed session first. A session that cannot be resumed is
  tagged ("Session deleted", or "Folder missing" when its workspace is gone)
  and its artifact opens read-only on the page; a deleted session's can be
  removed there.
- **Skills machine context** follows the active lane by default. Its header switcher
  offers This Mac and Hosts announcing `skills.read`. Remote skills are read-only;
  unavailable machines never fall back to local skills. Remote machines show their
  models and providers on the Skills page; This Mac shows them in Settings.
- **Skills discovery** is a capability workbench: outcome filters, task fit,
  evidence and limitations precede an expandable review/install section.
  Vercel React guidance and NVIDIA cuOpt routing install at reviewed commit
  pins; related benchmark results are not promises of local gains. Trail of
  Bits dimensional analysis is an external-plugin offering, not a standalone
  pi install, because its dedicated agents live outside the skill directory.
  Existing libraries remain expandable and searchable. Add is explicit,
  global, and installs only the skill bundle, not runtimes or dependencies.
  Yours retains source grouping, inspection, draft hiding, updates and deletion.
  Writable bundles have **Source → Edit source → Save source / Cancel edit**, for
  the main skill and its reference files. Read-only package/foreign skills stay
  read-only. Save failures keep the editor open. Availability changes apply to
  new sessions or `/reload`. The included `visual-artifacts` skill is a user-owned
  copy; **Restore artifact skill** reinstalls it only if removed, without
  overwriting edits. See [its lifecycle](extensions.md#the-artifact-tools-and-what-each-one-costs).
  Your own roots come first, then one read-only group per package
  (`Package · pi-subagents`), so each extension's skills are visible. When pi
  cannot be asked, the fallback scan still reads installed packages' skills.
- **Routines** — local scheduled tasks producing fresh lanes, with configuration,
  next-run previews, history, and explicit unattended access. Runs are owned by
  main, not this page; closing it never stops the scheduler. See [routines.md](routines.md).
- **Machines** is always available; see [below](#machines).
- **Toasts** — a stack at the top right, under the top bar, newest first and
  capped at four (also used by extension `notify`). A notice about a lane
  names it the way its sidebar row does (marker and title) and clicking it
  opens that lane; so does the lane's row, since any navigation to a lane
  dismisses its notice. A lane holds one notice at a time: a lane that comes
  up, is named and then finishes behind your back is one card that updates
  (with a small bump), not three. Timers pause while a card is hovered or
  focused and while the window is blurred, so a notice that lands while you
  are in another app is still there when you come back. Errors stay 9s, cards
  you can open 7s, the rest 5s.
- **Status strip** — the bottom of the chat pane, only while a session has
  something to say: an MCP chip (`connected/enabled`, tool count, "N need
  attention"; opens Settings → MCP Connectors), a sub-agent chip (background
  runs from pi-subagents' `subagent-async` widget, or the `claude-subagents`
  key of a session recorded before provider 0.9.0), and whatever prose an
  extension pushed through `setStatus`. `setStatus` is pi's only channel for
  extension state, so it doubles as a data bus: keys carrying structured
  payloads (context breakdown, rate limit, MCP, sub-agents, headroom) are
  filtered out of the strip and parsed by the component that owns them, and
  the composer's widget slot filters its structured keys the same way
  ([extensions.md](extensions.md#the-status-channel-is-a-wire-contract)). Crash notices are not here; update availability is the sidebar's
  pill.
- **Command palette** (Cmd/Ctrl+K): new session, go to file, toggle sidebar
  and each pane, open the Artifacts/Skills pages, rewind, expand/collapse tool
  output, settings and keybindings, theme, open a folder, switch workspace,
  open a session. Distinct from the chat `/` command menu.
- **Empty states**: no workspace → onboarding card with folder picker; no
  sessions → "Describe a task…" hero; pi missing/outdated → setup screen with
  the install command.

## Home workbench

Home keeps the first-prompt composer fixed below a separately scrolling,
responsive lane grid. Each tile belongs to a session in the selected project,
including its worktrees and live sessions whose first turn is not saved yet.
Live names override scanned names. Status, PR, branch and actions reuse the
lane board's existing classification and merge/update flows; idle is not a
claim of success or review approval.

On entry, actionable work comes before idle history. Positions are then stable
while the project's home stays mounted: updates, first save and suspend/resume
do not reorder tiles; new lanes append, deleted lanes leave. There is no persisted pinning or independent dashboard registry.
Completed/idle lanes stay available rather than disappearing. The grid uses
available pane width, collapsing to one column when needed.

The activity preview reuses chat tool summaries and the versioned background
snapshot parser. It shows at most three background roots, marks incomplete
previews, and never equates roots/workflows with a count of agents. Missing
activity is not fabricated: unopened transcripts show an invitation to open
the lane. “View subagents” activates that lane and opens its shared docked
Subagents pane; no inspection requests or activity polling happen just from
viewing home. Questions open their lane's
existing dialog rather than gaining a second answer path. The ledger and
collapsed project statistics remain below the tiles.

## Machines

One bordered list starts with this computer, using real pi health, Claude and
provider sign-in checks. Enrolled Hosts follow, sorted online first, then by
label. Rows show a status dot, hostname, human platform name and architecture,
status text, problem-only readiness chips (or Ready), and non-zero lane counts.
The whole row opens a stable detail view; live updates do not reset selection.
Signed out, only this computer is listed, with an optional GitHub sign-in panel.
Signed in with no Hosts, a three-step source-install, setup and login guide links
to the Host guide. There are no sample machines. Remote lanes, machine filters
and per-lane connection chips use authenticated Host snapshots. The home
machine picker follows the sidebar selection (All machines uses This Mac), with
a user override until the next sidebar change. Remote choices open the configured
repository dialog. Host-targeted submit opens that same dialog without sending or
clearing the composer draft, never starting locally if the Host is unavailable.
Provider and Model are under its collapsed Advanced disclosure.

Main owns directory traffic. Realtime is only a debounced change signal, with
60 s polling while disconnected. A 5 s local timer updates relative times and
judges silent Hosts down after 90 s, using the server clock correction. No
account means no control request. List loading, offline and account errors are
explicit and offer retry.

Details share Status, Readiness and About sections. Host details include the
last heartbeat, enrollment date, version, copyable fingerprint and machine id.
On this machine lists lanes and capability-gated skills, routines and artifact
counts, with links to machine-filtered pages. Down lanes stay labelled last known.
Problems give plain-language fixes and copyable commands to run on that Host.
A never-connected Host offers `phosphor run` and, on Linux,
`phosphor service install`. A Host offline for over a day suggests
`phosphor service status`. Rename edits the label inline: Enter or blur saves,
Escape cancels, and failure restores the saved label with an inline error.
Remove confirms that the Host stops at its next heartbeat and must run
`phosphor login` again. Its files and installation stay on that machine.

Add a machine is disabled while signed out. Its guided dialog has four steps:
commands to run on the other machine, code entry, fingerprint comparison and
editable label, then success with the run/service next step and View machine.
Codes accept either case and an optional separator, format as four letters per
group, and submit with Enter. Invalid, expired, rate-limited and network errors
stay on the current step. Approval is enrollment, not a remote execution grant.
