# 2026-08-22 — Sidebar density, resizable width, per-group "+"

## What changed

Four UI tweaks to the session sidebar (`src/features/sessions/Sidebar.tsx`),
modeled on the Claude desktop session list:

- **Resizable width.** The sidebar was a fixed `w-64` (256px), tight for long
  session titles and branch chips. It now has a drag handle on its right
  border (a 4px invisible strip that tints accent on hover), clamped to
  208–420px, persisted in `localStorage` under `Phosphor:sidebarWidth`. Renderer
  localStorage is the right home for pure-UI layout state — same place
  react-resizable-panels keeps the pane split — so no new IPC channel. A
  fixed full-screen overlay during the drag keeps the `col-resize` cursor and
  suppresses text selection.
- **Slightly denser vertically**, without shrinking any font: nav rows and
  the workspace switcher went `py-1.5 → py-1`, group headers / section labels
  `pt-3 → pt-2.5`, footer `py-2.5 → py-2`.
- **Per-group "+" button.** Each workspace group header now ends in a small
  plus (`workspace-group-new-session` testid) that does what the context
  menu's "New session here" does: open that workspace and route to the home
  composer. Revealed on header hover (opacity transition), `active:scale-90`
  press animation.
- **Caret moved to the right of the group name** instead of leading the row.
  For an expanded group it only appears on header hover; a collapsed group
  keeps it visible at rest, as the cue that there is hidden content.

## Structure note

The group header used to be one `<button>` (toggle + context menu). Nesting
the new plus inside it would be invalid HTML, so the header is now a wrapper
`div` (context menu target, `group/header` hover scope) containing the toggle
button — which keeps the `workspace-group` testid the e2e suite clicks — and
the plus button as a sibling.
