# 05 — Files, Editor, Diffs, Git

## File explorer

Implemented file-management behavior is documented in [files.md](../../files.md),
including creation from empty workspaces, copy/cut/paste, multi-selection and
file/folder drops (2026-09-05). Open-to-the-side remains deferred.

- Workspace tree: lazy-loaded directories, gitignore-aware toggle (default on), hidden-files toggle, git status dots (modified/added/untracked), live updates via chokidar.
- Context menu: reveal in OS file manager, copy path / relative path, new file, new folder, rename, delete (to trash), open to the side.
- Fuzzy file finder (Cmd/Ctrl+P) shared with the composer's `@` search index.

## Editor (Monaco)

- Tabbed open files; dirty indicators; Cmd/Ctrl+S saves.
- Theme-matched light/dark Monaco themes consistent with app tokens.
- Language services: syntax + basic IntelliSense that Monaco ships; no LSP requirement for v1.
- **External-change handling**: when the agent (or anything else) modifies an open file, hot-reload the buffer if not dirty; if dirty, non-blocking conflict bar ("File changed on disk — Reload / Keep mine / Diff").
- Open-at-line deep links from chat (read chips, edit diffs, grep results).

## Files Changed panel

- Accumulates every `edit`/`write` tool result per session: path, +/- line counts, badge for create/modify.
- Click → Monaco diff editor. Sources for the diff:
  1. Reconstruct from `details.patch` (unified patch) chained per file across the session, or
  2. When the workspace is a git repo, diff against a **session baseline**: record `git rev-parse HEAD` + a stash-free snapshot ref at session start; "Changes since session start" = `git diff <baseline>` scoped to touched files.
- Session-level summary row: N files changed, +X −Y.
- Revert affordance per file (git checkout / apply reverse patch) with a single confirm (this is file recovery UX, not an agent permission gate).

## Git (read-only v1)

- Workspace header chips: current branch, ahead/behind, dirty count (like the screenshots' branch chip).
- Refresh on chokidar events (debounced) + on session activity.
- No commit UI in v1 — the terminal and the agent cover it.
