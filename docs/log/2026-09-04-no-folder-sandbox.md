# "No folder" option: sandbox workspaces

2026-09-04

Every session needs a real cwd for pi, so Phosphor could only start a chat
inside a chosen project folder. Quick questions and throwaway experiments
had nowhere to go.

The folder menu (workspace chip) and the first-run picker now offer **No
folder**. Picking it asks main for a sandbox folder and opens it as the home
target:

- `app:createSandbox` (`electron/ipc/app-handlers.ts`) returns a
  `<userData>/sandboxes/sandbox-N` folder via `electron/sandbox.ts`. userData,
  not homedir, so E2E's `PHOSPHOR_TEST_USER_DATA` redirect keeps test runs out of
  the real one.
- From then on a sandbox is an **ordinary workspace**: it enters recents and
  hosts any number of sessions. Nothing downstream needed changing — the home
  screen already hides the branch/isolation controls for a non-git folder
  (`isRepo` in `WorkspaceHome.tsx`), and `startChat` already handles a
  non-repo cwd.

## Reuse, not a folder per click (same day)

The first cut minted a new folder on every pick, on the theory that a sandbox
is per-task scratch space and reusing one would mix unrelated files. In
practice a sandbox only fills up if the model writes to it, so asking twice
in a row left an empty `sandbox-N` behind every time — four sidebar groups
after a few minutes of poking, none of them holding anything.

`openSandboxFolder` now hands back the most recently touched **empty**
sandbox and mints a fresh one only when every existing sandbox holds
something. Emptiness ignores dotfiles: Finder drops a `.DS_Store` into any
folder it looks at.

## Deleting one

Nothing deleted a sandbox before, and "Remove" in Settings only forgot the
workspace — the folder stayed on disk with no way back to it.

- `app:deleteSandbox` moves the folder **and its transcripts** (pi's session
  directory, plus the Claude CLI's copy) to the Trash, then drops the
  workspace from recents. Trash rather than unlink, the same as deleting a
  session (`electron/pi/session-deleter.ts`): a folder meant as scratch may
  hold work the user wants back.
- The transcripts go with it because `sandbox-N` numbers are reused once the
  folder above them is gone. Leaving them would hand the next sandbox-4 the
  previous one's chat history.
- Main re-derives what is legal instead of trusting the path it is given:
  `resolveSandboxFolder` accepts only a `sandbox-N` folder directly inside
  the sandbox base, and a sandbox with a live session in it is refused.
- Two surfaces call it, both confirming in place rather than with a modal
  (the folder is recoverable from the Trash): **Settings → Workspaces →
  Sandboxes**, which lists every sandbox on disk with its item count and last
  use, and **Delete sandbox…** in the sidebar group's `⋯` menu. Sandboxes are
  filtered out of the Settings workspace list so one folder does not get two
  different delete buttons.
