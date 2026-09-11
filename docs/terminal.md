# 06 — Terminal

A full PTY terminal pane, independent of the agent. The agent's `bash` tool
calls render in chat, not here. It exists so you can run the command yourself
without leaving the session, and so a shell always sits in the right checkout.

- **Real shells.** node-pty in main, xterm.js in the renderer. `$SHELL` on
  macOS/Linux as a **login** shell (`-l`, so your PATH and rc files load, which
  is where pi lives), falling back to `/bin/zsh` on macOS and `/bin/bash`
  elsewhere; `powershell.exe` on Windows (`electron/pty/pty-manager.ts`).
- **Tabs.** Open several, rename, close. Every PTY is killed on quit,
  including the SIGINT/SIGTERM/SIGHUP paths Electron does not route through
  `before-quit`.
- **Looks like the app.** Theme-matched colours that switch live, the font
  from settings, ligature-capable mono.
- **Addons:** fit (follows pane dragging), clickable web links, search
  (Cmd/Ctrl+F inside the pane).
- **Clipboard is ours.** xterm ships no copy binding and its selection is
  invisible to the browser, so nothing copies by default. Copy/paste are ⌘C/⌘V
  on macOS and Ctrl+Shift+C/V on Windows and Linux, where plain Ctrl+C must
  stay SIGINT. Right-click opens Copy / Paste / Select all rather than pasting
  blind (`src/features/terminal/clipboardKeys.ts`).
- **Scrollback** is 10,000 lines. Main also keeps a 256 KB output tail per PTY
  and replays it on reattach, so closing and reopening the pane shows the live
  shell's recent output instead of a blank.
- **Per session.** Terminals belong to the session that opened them, and so
  does the pane selection. A shell opened in one lane never appears in
  another, and never auto-spawns a second one. Its cwd is that session's own
  directory, which for a worktree lane is the **worktree**. A shell in the repo
  root while its lane edits a worktree would run every command against the
  wrong tree (`src/stores/terminal.ts`).
- **A shell that cannot start is a UI state**, not a hang: the pane shows the
  spawn error with a retry (`electron/pty/spawn-helper.ts` handles node-pty's
  `spawn-helper` trap).
- **"Run in terminal"** opens the pane, spawns a tab for the active session if
  it has none, and pastes the command. Whether Enter goes with it depends on
  who wrote it: a chat code block pastes **without** executing (shell
  languages only; the model wrote it, so you review it), while a remediation
  Phosphor itself proposes runs on click (`RunCommandRow.tsx`; the play button
  is the confirmation). If no shell exists and none can start, the paste is
  dropped, since the pane is already showing the spawn error.
- Used by onboarding: "open a terminal running `pi` to log in".
