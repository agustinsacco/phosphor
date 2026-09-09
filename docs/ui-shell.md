# 03 — App Shell, Workspaces, Panes

## Window & chrome

- Frameless on every platform: `hiddenInset` traffic lights on macOS, `hidden` plus a theme-matched `titleBarOverlay` for the Windows/Linux window buttons (`electron/main.ts`). **There is no application menu** — nothing in `electron/` calls `Menu.buildFromTemplate` — so every command reaches the user through the top bar, the command palette, or a key binding, and Chromium's own zoom accelerators (which need a menu role) are re-implemented by hand in `useGlobalShortcuts.ts`.
- Window title: `<project> — Phosphor`, or `<repo> (<branch>) — Phosphor` when the folder is a worktree (`worktreeAwareName`, `src/lib/path.ts`); plain `Phosphor` before a workspace is open. The session name is deliberately absent: the OS title names the folder you are working in, and the session already owns the top bar and the sidebar row.
- Global shortcuts: Cmd/Ctrl+N **home screen** (it clears the active session rather than spawning one — the folder and the first prompt are both chosen there), Cmd/Ctrl+P fuzzy file finder, Cmd/Ctrl+, settings, Cmd/Ctrl+`terminal pane, Cmd/Ctrl+Shift+E files pane, Cmd/Ctrl+Shift+G changes pane, Cmd/Ctrl+B toggle sidebar, Cmd/Ctrl+/ the shortcut list, Cmd/Ctrl+plus / minus / 0 UI scale. Punctuation bindings match on`event.code`, not `event.key`, so a shifted or non-US layout still hits them. The full sheet, including the chords inherited from Claude Code (Esc Esc rewind, ↑/↓ prompt history, Tab/Shift+Tab list indentation or focus, Ctrl+O verbose output), is Settings → Keybindings, in four groups: App, Chat, Formatting, Editor & terminal.

**Shortcut scope:** New (Cmd/Ctrl+N), Go to file (Cmd/Ctrl+P), Files
(Cmd/Ctrl+Shift+E) and Changes (Cmd/Ctrl+Shift+G) work from the composer too.
F6 moves between the composer and pane controls, returning from global pages;
in a fullscreen pane it focuses Exit fullscreen rather than hidden chat.
Dialogs block app navigation (not zoom). IME/AltGr and editor-owned letter chords
are not interpreted as app commands. Terminal refits and search activation do not reclaim moved focus.
Bindings belong to the app document, not sandboxed artifact iframe contents.

### Top bar

A **single full-width bar** (`src/app/TopBar.tsx`) sits above the sidebar, chat, and pane columns: sidebar toggle, workspace chip, branch control ([WORKTREES.md](worktrees.md)), session title, then the pane switches — terminal, files, changes, artifacts — and the session kebab. The terminal switch carries a tab count and a running-process dot; the artifacts switch only appears once the session has an artifact, with a count and an unseen dot.

Everything right of the sidebar toggle is **session-only**. On the home screen the bar keeps its height and gutters but renders nothing else, because that screen puts the same folder and branch controls directly above its composer, where choosing them is the point — two identical folder chips on one screen is the "two answers to one question" problem the single bar exists to prevent.

It is the **only** element allowed in the strip the OS draws window controls in, and therefore the only call site of `.titlebar-inset-end` (right, Windows/Linux overlay) and `.titlebar-inset-start` (left, macOS traffic lights). This is structural, not cosmetic: those insets are `100vw`-relative, so they are only correct on an element that spans the window. Per-column headers cannot know whether they are the one under the OS buttons — when the chat header owned the inset, opening a right-hand pane put that pane's expand/close buttons directly beneath the real close button. Columns must not grow their own title bars.

## Startup

A full-window Phosphor loading screen uses the saved Light / Dark / System
appearance from the first paint (native window background plus preload), then
stays visible while bundled fonts, preferences, pi health, the previous
workspace/session transcript, and the visible sidebar's initial scan settle.
The shell mounts hidden and inert beneath it so discovery can finish without
showing skeletons or accepting app shortcuts. Readiness dismisses the screen;
there is no minimum display time, and later session switches/refreshes keep
their local loading states. Missing pi leads to setup; startup failures offer
retry, and a failed restore can be skipped. The model catalogue is preloaded
in the background but does not hold up the screen.

## Left sidebar (Claude Desktop style)

- **Workspace switcher** at top: current workspace name + dropdown of recent workspaces; "Open Folder…" via native picker. Adding a workspace records it in app prefs.
- **Flat nav rows** under it — `New`, `Artifacts`, `Skills` — icon plus label, no border or shadow. `New` (a plus in a bordered circle, the only row drawn that way) routes to the **home screen** via `activate(null)`; it does not spawn a session, because the folder and the first prompt are both chosen there. Artifacts and Skills open global pages (below).
- **Session list** for the active workspace: pinned section, then recent, grouped headers supported. Each row: session name (or first-message preview), relative timestamp, and state indicator. Starting/working lanes use the shared [Phosphor Beacon](style-guide.md#loading-identity--phosphor-beacon), a static amber edge rail, and an explicit status chip in place of the timestamp (time remains in its tooltip). This applies to background and pending lanes too. Idle/unread states retain their dots; the selected-row fill stays independent of activity. Context menu: open, session tree, pin, lane marker (unless markers are off), open pull request (only when the lane has one — the PR chip itself is mouse-only, so this is the keyboard route), suspend (live lanes only, labelled with the ~200 MB it reclaims), fork, clone, export HTML, copy debug info, copy spend (only once a session has cost anything), delete (trash).
- **Per-workspace lane search**: a magnifier in each group header opens a field under it; Enter filters that group's lanes by title, branch or PR, `x`/Escape retract it. See [lanes.md](lanes.md#finding-a-lane).
- **Group header toolbar**, permanent rather than hover-revealed (a control you cannot see is one you do not know exists): the magnifier, a kebab, and `+` for a new session in that folder. The kebab holds Select all lanes / Clear selection, **Move up / Move down** — this is where recent workspaces are reordered, not Settings — and, for a sandbox only, Delete sandbox behind a second click. A project folder is the user's and is only ever _forgotten_, from Settings → Workspaces.
- **Loading states per group**: never attempted → skeleton rows; partially scanned → the rows we have plus `loading N more folders…`; errored → "Couldn't load sessions" with Retry. A group's folders are the main repo plus every lane (`<repo>/.phosphor/worktrees/<slug>`) folded into it; an expanded group scans all of them, uncapped, while the 8-workspace cold-boot cap still governs collapsed ones. See [2026-08-28-sidebar-lane-scan.md](log/2026-08-28-sidebar-lane-scan.md).
- Footer: the **update pill** above the Settings entry. The pill is silent unless there is something to act on — checking, idle and failed downloads render nothing at all ([updates.md](updates.md)). Version, platform and runtime are in Settings → About, not here.
- Collapsible (Cmd/Ctrl+B), width-draggable.

## Pane system

Main area is the chat plus **one float pane**, split by a drag handle, persisted per session (selection, side, split size, fullscreen — localStorage, pruned on session dispose). The float region hosts exactly one pane at a time (`RightPane = 'files' | 'changes' | 'terminal' | 'artifacts' | null`, `src/stores/layout.ts`), closed and reopened from the top bar's pane switches, the command palette, or the shortcuts above — there is no view menu to reopen from, because there is no menu bar at all (see [Window & chrome](#window--chrome)).

1. **Chat pane** — always present ([04-chat.md](chat.md)).
2. **Files pane** — explorer tree + open-file tabs with Monaco ([files.md](files.md)), itself split by a second handle. Opening a file from tree, chat file-chips, or diffs lands here.
3. **Changes pane** — the working tree's modified files and their diffs. Files and Changes are two views of one "working tree" surface, so they share a segmented switcher in the pane header rather than two independent panes; Terminal and Artifacts render a plain title instead (`src/features/files/RightPane.tsx`).
4. **Terminal pane** — tabbed terminals ([06-terminal.md](terminal.md)).
5. **Artifacts pane** — gallery + viewer ([07-artifacts.md](specs/build/07-artifacts.md)); opens itself on a session's **first** artifact, and only when that session has no pane open already — a background session must never yank the foreground one's pane, and an incoming version never steals selection from an artifact you are reading. The cross-session index is the global Artifacts _page_ (below), not this pane.

Requirements:

- Drag-to-resize at 60fps (no layout thrash). The handles are plain `PanelResizeHandle`s — dragging is the only gesture, there is no double-click-to-reset.
- Layout persists and restores **per session**, so lanes keep independent arrangements across switches and app restarts; default: chat 55% / pane 45%, pane on the right. The panel group is keyed by session _and_ side, because `defaultSize` only applies at mount. The Files pane's own inner split is the exception: it stays on react-resizable-panels' per-**workspace** `autoSaveId`, since a tree/editor ratio is a property of the project, not the lane.
- The float pane can swap sides with the chat (⇄ in the pane header, per session).
- Fullscreen (↗) overlays the entire main region (sidebar and top bar stay); it never resizes the split underneath, so exiting restores the exact prior layout.
- Multiple sessions per workspace run **concurrently**; the chat pane shows the active session; switching sessions is instant (state held in stores keyed by sessionId); background sessions keep streaming into their stores.

**Changes navigation:** each file has a keyboard-operable Open button, separate
from Revert. A diff opens with focus on its named Back button; returning restores
focus to the originating row. Diffs use the same saved font family/size as the
editor, including live preference updates. Restore semantics are unchanged.

## Theming

- Light / Dark / System in settings. Tokens are CSS variables consumed by Tailwind; surfaces that take a theme object instead each carry a mirrored copy, listed in [style-guide.md](style-guide.md#color). All switch together, live, no reload.
- Design tokens per [00-overview.md](overview.md) brand direction.

## Global surfaces

- **Global pages** — Artifacts and Skills (sidebar rows, `data-testid="global-page"`). Full-main-region overlays belonging to no session, so they work from the home screen; any session activation (a lane row, New) closes them ([2026-09-05-skills-artifacts-pages.md](log/2026-09-05-skills-artifacts-pages.md)). Skills lives only here — browse, create, import/export and install into pi's global or project roots ([2026-09-04-skills-page.md](log/2026-09-04-skills-page.md)). The Artifacts page indexes every open session's artifacts; opening one jumps to its session with the per-session pane on it.
- **Toasts** (also used by extension `notify`).
- **Status strip** — the bottom of the **chat pane only** (`StatusStrip` in `src/features/extension-ui/ExtensionUiHosts.tsx`, mounted by `ChatView`), and only while a session has something to say. Three things live there: an MCP chip (`connected/enabled`, tool count, "N need attention"; clicking opens Settings → MCP Connectors), a sub-agent chip, and whatever prose an extension pushed through `setStatus`. `setStatus` is pi's only channel for extension state, so it doubles as a data bus: keys carrying structured payloads (context breakdown, rate limit, MCP, sub-agents, headroom) are filtered out of the strip and parsed by the component that owns them. Crash/restart notices are **not** here, and update availability is the sidebar's update pill ([updates.md](updates.md)).
- **Command palette** (Cmd/Ctrl+K, its own listener so it works while the palette input has focus): new session, go to file, toggle sidebar and each pane, open the Artifacts/Skills pages, rewind, expand/collapse tool output, settings and keybindings, theme, open a folder, switch workspace, open a session — distinct from the chat `/` command menu.
- **Empty states**: no workspace → warm onboarding card with folder picker; no sessions → "Describe a task…" hero; pi missing/outdated → setup screen with install command ([08-sessions.md](specs/build/08-sessions.md)).
