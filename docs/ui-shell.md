# 03 — App Shell, Workspaces, Panes

## Window & chrome

- Native frame conventions per OS (hiddenInset traffic lights on macOS).
- Window title: `workspace · session name`.
- Global shortcuts: Cmd/Ctrl+N new session, Cmd/Ctrl+P fuzzy file finder, Cmd/Ctrl+, settings, Cmd/Ctrl+` toggle terminal pane, Cmd/Ctrl+B toggle sidebar, Cmd/Ctrl+/ the shortcut list. The full sheet, including the chords inherited from Claude Code (Esc Esc rewind, ↑/↓ prompt history, Tab/Shift+Tab list indentation or focus, Ctrl+O verbose output), is Settings → Keybindings.

**Shortcut scope:** New (Cmd/Ctrl+N), Go to file (Cmd/Ctrl+P), Files
(Cmd/Ctrl+Shift+E) and Changes (Cmd/Ctrl+Shift+G) work from the composer too.
F6 moves between the composer and pane controls, returning from global pages;
in a fullscreen pane it focuses Exit fullscreen rather than hidden chat.
Dialogs block app navigation (not zoom). IME/AltGr and editor-owned letter chords
are not interpreted as app commands. Terminal refits and search activation do not reclaim moved focus.
Bindings belong to the app document, not sandboxed artifact iframe contents.

### Top bar

A **single full-width bar** (`src/app/TopBar.tsx`) sits above the sidebar, chat, and pane columns: sidebar toggle, workspace chip, branch control ([WORKTREES.md](worktrees.md)), session title, then the pane switches and the session kebab.

It is the **only** element allowed in the strip the OS draws window controls in, and therefore the only call site of `.titlebar-inset-end` (right, Windows/Linux overlay) and `.titlebar-inset-start` (left, macOS traffic lights). This is structural, not cosmetic: those insets are `100vw`-relative, so they are only correct on an element that spans the window. Per-column headers cannot know whether they are the one under the OS buttons — when the chat header owned the inset, opening a right-hand pane put that pane's expand/close buttons directly beneath the real close button. Columns must not grow their own title bars.

## Left sidebar (Claude Desktop style)

- **Workspace switcher** at top: current workspace name + dropdown of recent workspaces; "Open Folder…" via native picker. Adding a workspace records it in app prefs.
- **New Session** button (prominent, labelled `+ New`).
- **Session list** for the active workspace: pinned section, then recent, grouped headers supported. Each row: session name (or first-message preview), relative timestamp, running indicator (spinner while streaming; unread/completed badge for background sessions). Context menu: open, session tree, pin, suspend, fork, clone, export HTML, copy debug info, copy spend (only once a session has cost anything), delete (trash).
- **Per-workspace lane search**: a magnifier in each group header opens a field under it; Enter filters that group's lanes by title, branch or PR, `x`/Escape retract it. See [lanes.md](lanes.md#finding-a-lane).
- **Loading states per group**: never attempted → skeleton rows; partially scanned → the rows we have plus `loading N more folders…`; errored → "Couldn't load sessions" with Retry. A group's folders are the main repo plus every lane (`<repo>/.pidex/worktrees/<slug>`) folded into it; an expanded group scans all of them, uncapped, while the 8-workspace cold-boot cap still governs collapsed ones. See [2026-08-28-sidebar-lane-scan.md](log/2026-08-28-sidebar-lane-scan.md).
- Settings entry + app identity at the bottom.
- Collapsible (Cmd/Ctrl+B), width-draggable.

## Pane system

Main area is a **resizable multi-pane layout** with drag handles, persisted per-session (selection, side, split size, fullscreen — localStorage, pruned on session dispose), panes closable/reopenable from a view menu and shortcuts:

1. **Chat pane** — always present ([04-chat.md](chat.md)).
2. **Files pane** — file management and explorer tree + open-file tabs with Monaco ([files.md](files.md)). Opening a file from tree, chat file-chips, or diffs lands here.
3. **Terminal pane** — tabbed terminals ([06-terminal.md](terminal.md)).
4. **Artifacts pane** — gallery + viewer ([07-artifacts.md](specs/build/07-artifacts.md)); opens automatically when a session produces its first artifact. The cross-session index is the global Artifacts _page_ (below), not this pane.

Requirements:

- Drag-to-resize at 60fps (no layout thrash), double-click a handle to reset split.
- Layout persists and restores **per session**, so lanes keep independent arrangements across switches and app restarts; default: chat 55% / pane 45%, pane on the right.
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
- **Status strip** (bottom of chat pane or window): extension `setStatus` entries, pi crash/restart notices, update availability.
- **Command palette** (Cmd/Ctrl+K): app actions (new session, toggle panes, switch workspace/session, theme) — distinct from the chat `/` command menu.
- **Empty states**: no workspace → warm onboarding card with folder picker; no sessions → "Describe a task…" hero; pi missing/outdated → setup screen with install command ([08-sessions.md](specs/build/08-sessions.md)).
