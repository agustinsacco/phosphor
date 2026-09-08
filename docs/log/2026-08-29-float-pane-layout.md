# Float panes: real fullscreen, side swap, compact artifact header, per-session layout memory

Four defects in the right-hand float card (Files / Changes / Terminal /
Artifacts), fixed together because they share one root: layout state lived in
the wrong places.

## What was wrong

1. **"Fullscreen" was a resize.** ↗ imperatively resized the split to 85/15
   (`App.tsx`), crushing the chat to an unusable column. Restore hardcoded
   45%, discarding any dragged size.
2. **The squish leaked across sessions.** Split sizes persisted via
   react-resizable-panels `autoSaveId="Phosphor-main-${workspacePath}"` — per
   workspace, not per session — so the 85% written by expand became every
   other session's opening layout.
3. **The pane could only sit on the right.** Panel order was hardcoded.
4. **Artifact header burned four rows (~160px)** before content: shell label
   ("Artifacts · N artifacts"), gallery chip row, per-artifact title band,
   then the toolbar.
5. **Pane state didn't survive a restart.** `bySession` was per-session but
   in-memory only.

## What changed

- **Fullscreen is an overlay** (`MainWithPanes`): the pane leaves the split
  and covers the main region on an opaque `bg-bg` layer (sidebar + top bar
  stay). The chat reflows to full width underneath — invisible behind the
  opaque layer — and the saved size is never mutated, so exit restores the
  exact prior split. The e2e asserts transcript width before == after.
- **Layout is one persisted per-session record** in `stores/layout.ts`:
  `{ pane, expanded, side, size }`, debounce-written to localStorage
  (`Phosphor-pane-layout`), sanitized field-by-field on load
  (`sanitizePersistedPanes`), pruned by the existing `removeSession` path.
  The main PanelGroup dropped `autoSaveId`; it is keyed by
  `sessionId:side` so each session's `defaultSize` re-applies on switch.
- **Side swap**: ⇄ in the shared `PaneShell` header flips `side` per
  session; the panel order and the card's gutter follow. Hidden while
  fullscreen.
- **Compact artifact header**: the selected artifact (glyph, title, age) IS
  the pane title; with >1 artifact it becomes a `PopupMenu` dropdown
  switcher. The chip row and the title band are gone — two rows total
  (shell header + Preview/Code/Diff toolbar with version select and
  copy/save/open, unchanged).

## Notes

- Toggling fullscreen remounts the pane subtree (overlay vs split are
  different mounts — mounting both would double-attach xterm). Same recovery
  path as close/reopen, which already replays terminal scrollback.
- No Esc-to-exit yet: a window-level Esc listener races PopupMenu/modal Esc
  handling (stopPropagation does not cross window listeners). The ↗/↙ button
  is the exit.
- `specs/reference/ui-shell.md` §Pane system updated from per-workspace to
  per-session persistence.
- Also pinned an e2e assertion that the composer's helper buttons
  (`format-buttons` testid) stay visible — they were reported missing but
  were only absent in a stale running build.
