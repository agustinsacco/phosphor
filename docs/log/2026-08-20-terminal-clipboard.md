# 2026-08-20 — You could not copy out of the terminal

## The bug

Selecting text in the terminal pane and pressing Ctrl+C (Linux) did nothing but
send SIGINT to the shell. There was no other way to copy: right-click pasted
immediately, so the native context menu never appeared, and the app has no
Electron menu bar with an Edit > Copy role.

## Why

xterm.js has no copy binding of its own. Its selection is a set of painted
rows, not a DOM selection, so:

- the browser's Copy command has nothing selected to act on, and xterm's
  internal `copy` listener (`copyHandler` on the terminal element) only ever
  fires if something else produces a real copy event;
- `evaluateKeyboardEvent` turns Ctrl+C into ETX and cancels the event, which is
  correct — Ctrl+C is SIGINT in a terminal — so copy has to live somewhere else.

Every terminal emulator solves this the same way: Ctrl+Shift+C/V on
Windows+Linux, ⌘C/⌘V on macOS (where Cmd chords are never turned into input).
Phosphor had implemented neither. `specs/reference/terminal.md` listed "clipboard (copy
on select optional, paste)" as an addon, which is not a thing xterm provides.

## The fix

- `src/features/terminal/clipboardKeys.ts` — pure `clipboardActionFor(event,
platform)` → `'copy' | 'paste' | null`, matched on `event.code` (Shift makes
  `event.key` `'C'`), plus `clipboardModifiers()` so the chord is spelled in
  exactly one place. Unit-tested, including that plain Ctrl+C stays untouched.
- `TerminalView` wires it into the existing `attachCustomKeyEventHandler`.
  Copy writes `term.getSelection()` and clears the selection; paste goes
  through `term.paste()` so bracketed-paste mode is honoured.
- Right-click now opens the app's `showContextMenu` (Copy / Paste / Select all)
  instead of pasting blind. Copy is disabled with no selection. This is a
  behaviour change: right-click used to be an instant paste.
- Settings > Keybindings lists both rows, spelled per platform.
- Dark-theme `selectionBackground` went `#3d322066` → `#8a6a2f66`. Blended over
  `--px-bg` the old value landed within a few points of the background, so a
  drag-select looked like it had not selected anything — half of "I can't copy".
