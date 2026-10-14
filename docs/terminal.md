# 06 — Terminal

A full PTY terminal pane, independent of the agent. The agent's `bash` tool
calls render in chat, not here. It exists so you can run the command yourself
without leaving the session, and so a shell always sits in the right checkout.

- **Real shells.** node-pty in main, xterm.js in the renderer. `$SHELL` on
  macOS/Linux as a **login** shell (`-l`, so your PATH and rc files load, which
  is where pi lives), falling back to `/bin/zsh` on macOS and `/bin/bash`
  elsewhere; `powershell.exe` on Windows (`apps/desktop/electron/pty/pty-manager.ts`).
- **Tabs.** Open several, rename, close. Every PTY is killed on quit,
  including the SIGINT/SIGTERM/SIGHUP paths Electron does not route through
  `before-quit`.
- **Looks like the app.** Theme-matched colours that switch live, the font
  from settings, ligature-capable mono.
- **Addons:** fit (follows pane dragging), clickable web links, search
  (Cmd/Ctrl+F inside the pane).
- **Links open in the default browser.** Detected HTTP(S) URLs and OSC 8
  hyperlinks emitted by terminal programs share the main-process URL allowlist.
  Click, Ctrl-click, and Cmd-click open the link without navigating the app or
  creating an app window. On macOS, Ctrl-click over a link does not open the
  clipboard menu; ordinary right-click still does. Non-HTTP(S) OSC 8 links
  cannot launch files or custom protocol handlers.
- **Clipboard is ours.** xterm ships no copy binding and its selection is
  invisible to the browser, so nothing copies by default. Copy/paste are ⌘C/⌘V
  on macOS and Ctrl+Shift+C/V on Windows and Linux, where plain Ctrl+C must
  stay SIGINT. These bindings cancel the browser's default clipboard action so
  each shortcut pastes only once, through xterm's bracketed-paste handling.
  Right-click opens Copy / Paste / Select all rather than pasting blind
  (`apps/desktop/src/features/terminal/clipboardKeys.ts`).
- **Scrollback** is 10,000 lines. Main also keeps an output tail capped at
  262,144 UTF-16 code units per PTY and replays it on reattach, so closing and
  reopening the pane shows the live shell's recent output instead of a blank.
  A chunk deque drops old output without copying the retained tail on each
  append; only reattach joins the chunks. Retention happens before broadcasting
  live output, preserving the attach replay ordering.
- **Per session.** Terminals belong to the session that opened them, and so
  does the pane selection. A shell opened in one lane never appears in
  another, and never auto-spawns a second one. Its cwd is that session's own
  directory, which for a worktree lane is the **worktree**. A shell in the repo
  root while its lane edits a worktree would run every command against the
  wrong tree (`apps/desktop/src/stores/terminal.ts`).
- **A shell that cannot start is a UI state**, not a hang: the pane shows the
  spawn error with a retry (`apps/desktop/electron/pty/spawn-helper.ts` handles node-pty's
  `spawn-helper` trap).
- **"Run in terminal"** opens the pane, spawns a tab for the active session if
  it has none (or the active shell exited or is busy), and focuses it with the
  command pasted. First-open and chat actions share the same pending spawn.
  A paste targets that PTY only and waits for xterm to parse the shell output,
  including bracketed-paste mode; it cannot land in another session or login
  terminal. Trailing fence newlines are removed. If the shell has not enabled
  bracketed paste (including macOS system Bash), multiline commands stay in a
  focused editor inside the terminal pane. Enter or Run command executes the
  reviewed text; Shift+Enter adds a line, and Cancel discards it without sending
  anything to the shell. Single-line commands still paste at the prompt.
  Whether Enter goes with it depends on
  who wrote it: a chat code block pastes **without** executing (shell
  languages only; the model wrote it, so you review it), while a remediation
  Phosphor itself proposes runs on click (`RunCommandRow.tsx`; the play button
  is the confirmation). Enter is sent separately from bracketed paste. If no
  shell exists and none can start, the paste is
  dropped, since the pane is already showing the spawn error.
- Used by onboarding: "open a terminal running `pi` to log in".

## Host terminals

The Host protocol supports lane-owned PTYs when `ready` includes `terminal`.
Viewers can watch; only the current controller can type. PTYs survive client
disconnects, not Host restarts. The Host chooses the login shell, environment
and lane directory. Routines never type into them. UTF-8 scrollback is bounded
to 256 KiB and 2048 chunks; reconnects replay a valid cursor or reset to that tail.
Input is sequenced and acknowledged, never automatically retried after uncertainty.
Desktop routes remote lane tabs through main's terminal bridge. The renderer sees
only opaque Desktop ids. Create, resize and kill use receipts and the current lane
fence; typing uses main-owned input sequence numbers with at most 4096 UTF-8 bytes
per frame. A write stops at the first uncertain acknowledgement and is never
resent. While a frame is in flight, main queues up to 64 KiB of new UTF-8 input
and sends it in order after accepted acknowledgements. Overflow refuses only the
new write. Queued writes reject with fixed text and are discarded on uncertainty,
reset, invalidation, or loss of control or capabilities. No input is logged.
Reconnect suspends mutations until a fresh reset supplies `inputSeq`.
Reset scrollback clears and redraws the terminal after a stream gap, without
repeating output. An attach without a reset within five seconds closes its watch
and shows "Terminal unavailable." with an explicit Retry control. Failed attaches
discard held output; Retry attaches anew and redraws fresh scrollback. Controllers
send the current fitted terminal size after successful attach. Interrupted terminals appear ended. A Host restart or replaced
connection ends the Desktop mapping instead of binding it to a new PTY. Closing
its lane handle or removing the lane also invalidates the mapping.
Viewers can use View terminal to watch an existing shell. Reopening the same
Host terminal selects its existing tab. An empty list shows "Read-only: no
terminals available." They do not auto-create
shells, and input, resize and kill are disabled. The pane shows the read-only
hint. Without the `terminal` capability it shows "Not available on remote lanes
yet." Local tabs keep the behavior above.
See [Host terminals](host.md#host-terminals) for the wire limits and native build.
