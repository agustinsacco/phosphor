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
  and first prompt are chosen there), Cmd/Ctrl+P fuzzy file finder, Cmd/Ctrl+,
  settings, Cmd/Ctrl+backtick terminal pane, Cmd/Ctrl+Shift+E files pane,
  Cmd/Ctrl+Shift+G changes pane, Cmd/Ctrl+B sidebar, Cmd/Ctrl+/ the shortcut
  list, Cmd/Ctrl+plus / minus / 0 UI scale. Punctuation bindings match on
  `event.code`, so shifted and non-US layouts still hit them. The full sheet,
  including the chords inherited from Claude Code (Esc Esc rewind, ↑/↓ prompt
  history, Tab/Shift+Tab, Ctrl+O verbose output), is Settings → Keybindings.

**Shortcut scope:** New, Go to file, Files and Changes work from the composer.
F6 moves between the composer and pane controls; in a fullscreen pane it
focuses Exit fullscreen. Dialogs block app navigation (not zoom). IME/AltGr and
editor-owned letter chords are never read as app commands. Bindings belong to
the app document, not to artifact iframe contents.

### Top bar

One **full-width bar** (`src/app/TopBar.tsx`) above the sidebar, chat and
pane columns: sidebar toggle, workspace chip, branch control
([worktrees.md](worktrees.md)), session title, the pane switches (terminal,
files, changes, artifacts) and the session kebab. The terminal switch carries a
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

- **Workspace switcher** at top: current workspace plus a dropdown of recents;
  "Open Folder…" via the native picker.
- **Flat nav rows**: `New`, `Artifacts`, `Skills`. `New` routes to the home
  screen; it does not spawn a session, because the folder and the first prompt
  are chosen there. Artifacts and Skills open global pages (below).
- **Session list** for the active workspace: pinned, then recent, with group
  headers. Each row: name (or first-message preview), relative time, state.
  Starting/working lanes use the shared
  [Phosphor Beacon](style-guide.md#loading-identity--phosphor-beacon), an amber
  edge rail and a status chip in place of the timestamp. Context menu: open,
  session tree, pin, lane marker, open pull request (when the lane has one;
  this is the keyboard route, the chip is mouse-only), suspend (live lanes,
  labelled with the ~200 MB it reclaims), fork, clone, export HTML, copy debug
  info, copy spend, delete (trash).
- **Per-workspace lane search**: a magnifier in each group header. See
  [lanes.md](lanes.md#finding-a-lane).
- **Group header toolbar**, always visible: the magnifier, a kebab, and `+`
  for a new session in that folder. The kebab holds Select all / Clear
  selection, **Move up / Move down** (this is where recents are reordered) and,
  for a sandbox only, Delete sandbox behind a second click. A project folder is
  only ever _forgotten_, from Settings → Workspaces.
- **Loading states per group**: never attempted → skeleton rows; partly
  scanned → the rows we have plus `loading N more folders…`; errored →
  "Couldn't load sessions" with Retry. A group is the main repo plus every lane
  under `<repo>/.phosphor/worktrees/`, folded in. An expanded group scans all of
  them; the 8-workspace cold-boot cap governs collapsed ones.
- Footer: the **update pill** above Settings. Silent unless there is something
  to act on ([updates.md](updates.md)). Version and platform are in Settings →
  About.
- Collapsible (Cmd/Ctrl+B), width-draggable.

## Pane system

The main area is the chat plus **one float pane**, split by a drag handle and
persisted per session (selection, side, split size, fullscreen; localStorage,
pruned on dispose). The float region hosts exactly one pane at a time
(`RightPane = 'files' | 'changes' | 'terminal' | 'artifacts' | null`,
`src/stores/layout.ts`), opened from the top bar's switches, the command
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
   reading. The cross-session index is the global Artifacts _page_, below.

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
- Sessions in a workspace run **concurrently**. The chat shows the active one;
  switching is instant; background sessions keep streaming into their stores.

**Changes navigation:** each file has a keyboard-operable Open button, separate
from Revert. A diff opens with focus on its Back button, and returning restores
focus to the originating row. Diffs use the editor's saved font.

## Theming

Light / Dark / System in settings. Tokens are CSS variables consumed by
Tailwind; surfaces that take a theme object (Monaco, xterm, Mermaid, Chart)
each carry a mirrored copy, listed in [style-guide.md](style-guide.md#color).
All switch together, live, no reload.

## Global surfaces

- **Global pages** — Artifacts and Skills (sidebar rows). Full-main-region
  overlays belonging to no session, so they work from the home screen; any
  session activation closes them. Skills lives only here: browse, create,
  import/export and install into pi's global or project roots. The Artifacts
  page indexes every open session's artifacts; opening one jumps to its
  session with the pane on it.
- **Toasts** (also used by extension `notify`).
- **Status strip** — the bottom of the chat pane, only while a session has
  something to say: an MCP chip (`connected/enabled`, tool count, "N need
  attention"; opens Settings → MCP Connectors), a sub-agent chip, and whatever
  prose an extension pushed through `setStatus`. `setStatus` is pi's only
  channel for extension state, so it doubles as a data bus: keys carrying
  structured payloads (context breakdown, rate limit, MCP, sub-agents,
  headroom) are filtered out of the strip and parsed by the component that
  owns them. Crash notices are not here; update availability is the sidebar's
  pill.
- **Command palette** (Cmd/Ctrl+K): new session, go to file, toggle sidebar
  and each pane, open the Artifacts/Skills pages, rewind, expand/collapse tool
  output, settings and keybindings, theme, open a folder, switch workspace,
  open a session. Distinct from the chat `/` command menu.
- **Empty states**: no workspace → onboarding card with folder picker; no
  sessions → "Describe a task…" hero; pi missing/outdated → setup screen with
  the install command.
