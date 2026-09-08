# Claude Code chords, and tighter menus

Two passes over the same surface: every action Phosphor offers that Claude Code or
Claude Desktop binds to a key now has that key, and every popover that had
grown into prose got cut back to labels.

## The shortcuts

Phosphor already had the desktop-app half (⌘N, ⌘K, ⌘P, ⌘B, ⌘,, ⌘\`, ⌘⇧E, ⌘⇧G,
Enter/⌥Enter/Esc in the composer). What it did not have was the terminal half —
the chords someone arrives with after a day in Claude Code, presses here, and
gets nothing from. Five landed:

| Chord   | Action                        | Where                               |
| ------- | ----------------------------- | ----------------------------------- |
| Esc Esc | Rewind to an earlier message  | `Composer.tsx` → `openForkPicker`   |
| ↑ / ↓   | Previous / next prompt        | `promptHistory.ts`                  |
| ⇧Tab    | Cycle orchestrator mode       | `cycleOrchestratorMode`             |
| ⌃O      | Expand / collapse tool output | `uiState.verbose` → `ActivityGroup` |
| ⌘/      | The shortcut list itself      | `useGlobalShortcuts`                |

Three decisions inside those:

- **The prompt history is the transcript.** Every send already appends a user
  item to the chat store before pi echoes it back, so `promptHistory()` reads
  the session's own user messages instead of Phosphor keeping a second list to
  persist and drift. A session resumed from disk has its history immediately.
- **Browsing ends at the first keystroke.** ↑ recalls only from an empty
  composer or while already browsing; `onChange` clears the index, so the
  arrows go back to moving the caret the moment there is text of your own in
  there. The first attempt gated recall on the caret being at offset 0, which
  in a wrapped textarea is a position you almost never reach — ↑ looked broken
  after the first entry.
- **⌃O flips a default, not a lock.** `uiState.verbose[sessionId]` is what a
  group falls back to (`userOpen ?? verbose`), and changing it drops every
  group's own override — otherwise "expand everything" would skip exactly the
  groups the user had collapsed by hand, and clicking a group while verbose was
  on would do nothing.

⌃O and ⇧Tab are Control and Tab on every platform, not `mod`, because that is
what they are in Claude Code. `lib/shortcuts.ts` grew a `ctrl` modifier for
that (⌃ on macOS, Ctrl elsewhere) — `mod` would have rendered ⌘O on a Mac.

## The menus

The session context menu was the worst of it: nine rows, four of them carrying
a parenthetical ("Suspend (free ~200 MB)", "Fork (new branch session)", "Delete
(move to trash)"). The parentheticals were real information, so they moved
rather than disappeared — `ContextMenuItem` now has `hint` (muted, right-aligned)
and `shortcut` (mono, right-aligned), and the label is a verb again.

Also in `ContextMenuHost`: the viewport clamp measured a **guess** — 220px wide,
30px per row, separators ignored. Rows now size to their content, so the guess
was wrong in both axes and long menus ran off the bottom of the window. It
measures its own box in a layout effect instead, which runs before paint.

Elsewhere:

- **Session kebab**: twelve rows to six. Two labelled sections of two radio rows
  each ("Steering delivery" / "Follow-up delivery") became one row per queue
  showing its current mode, cycling in place. Toggles and cycles keep the menu
  open now; only the two commands close it.
- **Terminal menu** stopped padding shortcuts into the label string
  (`` `Copy  ${…}` ``) and passes `shortcut` instead.
- **Orchestrator menu**: "(spends tokens)" and "(keeps the thread)" became
  hints. The token warning stays visible — it is the one thing in that menu a
  user must not miss.
- **Reveal in file manager** is now "Reveal in Finder" / "Show in Explorer" per
  platform (`lib/reveal.ts`). The generic phrasing was correct everywhere and
  natural nowhere.
- Menu rows lost a padding step (`py-1.5` → `py-1`) and popovers went from
  `rounded-xl` to `rounded-lg`; the workspace switcher lost its "Workspaces"
  eyebrow and the thinking menu its "Thinking" one, both of which repeated the
  trigger that opened them.

## Tests

`promptHistory.test.ts` covers the recall walk (including the no-wrap stop at
the oldest entry and the draft coming back). The smoke test that asserted on
`Fork (new branch session)` now scopes to the menu's own `data-testid` and
matches `/^Fork/`, so a label edit does not break it again.
