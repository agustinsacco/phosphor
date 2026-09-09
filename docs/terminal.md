# 06 — Terminal

Full PTY terminal pane, independent from the agent (agent `bash` tool calls render in chat, not here).

- node-pty in main process; xterm.js in renderer; per-OS default shell — `$SHELL` on mac/linux as a **login** shell (`-l`, so the user's PATH/rc files load: pi lives there), falling back to `/bin/zsh` on macOS and `/bin/bash` elsewhere, `powershell.exe` on Windows (`electron/pty/pty-manager.ts`). Spawn cwd is the **owning session's** directory, not the repo root — see the per-session bullet below.
- Multiple tabs; rename; close; every PTY killed on app quit — `ptyManager.killAll()` on `before-quit`, and again from the `SIGINT`/`SIGTERM`/`SIGHUP` handlers for the shutdowns Electron does not route through it.
- Theme-matched colors (light/dark switch live), font from settings, ligature-capable mono font.
- Addons: fit (resize-aware with pane dragging), web links (clickable), search (Cmd/Ctrl+F within pane).
- Clipboard is ours, not xterm's — xterm ships no copy binding and its selection
  is invisible to the browser, so nothing (not the native menu, not ⌘C) can copy
  it by default. Copy/paste are ⌘C/⌘V on macOS and Ctrl+Shift+C/V on
  Windows+Linux, where plain Ctrl+C must stay SIGINT; right-click opens a
  Copy/Paste/Select-all menu rather than pasting blind. See
  `src/features/terminal/clipboardKeys.ts`.
- Scrollback is a hardcoded 10,000 lines (`scrollback: 10_000` in
  `src/features/terminal/TerminalView.tsx`) — no setting reads it. Main also keeps a bounded
  (256 KB) output tail per PTY and replays it over `pty:attach`, because
  closing the pane disposes the xterm while the shell keeps running — without
  the replay, reopening shows a blank pane in front of a live shell.
- The pane is **per session**: terminals belong to the session that opened them,
  and so does the right-pane selection itself. A terminal opened in one session
  must not appear — or auto-spawn a second shell — when you switch to another.
  Their cwd is that session's own directory, which for a worktree lane is the
  **worktree**: the pane spawns in the open workspace (activation keeps the
  open workspace paired with the session, and `startChat` opens the worktree),
  and `runInTerminal` goes further and prefers `live[sessionId].workspacePath`
  over its `workspacePath` argument (`src/stores/terminal.ts`). A shell that
  landed in the repo root while its lane edits a worktree would run every
  command against the wrong tree.
- A shell that cannot start is a first-class UI state, not a silent hang: the
  pane shows the spawn error with a retry. (See `electron/pty/spawn-helper.ts`
  for the node-pty `spawn-helper` trap that made this necessary.)
- **"Run in terminal"** (`runInTerminal`, `src/stores/terminal.ts`) opens the
  terminal pane, spawns a tab for the active session if it has none, and queues
  the command as a paste. Whether the newline goes with it depends on **who
  wrote the command**, and the split is deliberate: a chat code block pastes
  without executing (`CodeBlock.tsx`, shell languages only — the model wrote it,
  so review is the user's call), while a command Phosphor itself proposes as a
  known remediation passes `{ execute: true }` and runs on click
  (`src/components/RunCommandRow.tsx` — the play button IS the confirmation).
  If no shell exists and none can be started, the paste is dropped rather than
  stranded in the store: the pane is already showing the spawn error.
- Used by onboarding: "open a terminal running `pi` to log in" ([08-sessions.md](specs/build/08-sessions.md)).
