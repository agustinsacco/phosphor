/**
 * Path helpers for display. These operate on the POSIX-and-Windows mix of
 * separators that reaches the renderer, so they split on both.
 */

const SEPARATORS = /[/\\]/

/** Last path segment: `src/lib/a.ts` → `a.ts`. Falls back to the input. */
export function basename(path: string): string {
  const parts = path.split(SEPARATORS)
  return parts[parts.length - 1] || path
}

/** Everything before the last separator: `src/lib/a.ts` → `src/lib`. */
export function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? '' : path.slice(0, index)
}

/** Split into directory and basename in one pass, for two-tone list rows. */
export function splitPath(path: string): { dir: string; base: string } {
  return { dir: dirname(path), base: basename(path) }
}

/**
 * Display name for a workspace folder. Trailing separators are ignored, so
 * `/home/u/proj/` and `/home/u/proj` both yield `proj`.
 */
export function workspaceName(workspacePath: string): string {
  return workspacePath.split(SEPARATORS).filter(Boolean).pop() ?? workspacePath
}

/**
 * True for a path inside a repo's internal worktree folder
 * (`<repo>/.phosphor/worktrees/<name>`).
 *
 * A worktree is a *branch* of an existing workspace, not a workspace of its
 * own, so it must never be persisted as one — otherwise the sidebar and the
 * workspace switcher fill with a header per chat instead of one header per
 * project.
 */
export function isWorktreeFolder(path: string): boolean {
  // `.pidex` is the pre-rename (2026-09-08) folder; existing lanes still live there.
  return /[/\\]\.(?:phosphor|pidex)[/\\]worktrees[/\\]/.test(path)
}

/**
 * The project a path belongs to: the repo root for a linked worktree, the path
 * itself for anything else.
 *
 * Three sources, in order, because they fail in opposite directions:
 *
 *  1. `git.isWorktree` + `mainRepoPath`, which is authoritative and works for
 *     a worktree anywhere on disk — but arrives over a batched `git:infoBatch`
 *     round trip, so it is `undefined` on the first paint of every surface.
 *  2. `knownRoot` — the repo `git worktree list` reported this folder under.
 *     The sidebar's worktree discovery already has it at the moment it learns
 *     the path, so passing it costs nothing and needs no round trip. Covers
 *     worktrees anywhere on disk, unlike step 3.
 *  3. The path shape `<repo>/.phosphor/worktrees/<name>`, which needs no I/O and
 *     is true the moment the path exists. It only knows about worktrees Phosphor
 *     created, which is why it is the last fallback and not the primary.
 *
 * Without step 2, a worktree that is not under `.phosphor/worktrees` (a sibling
 * folder, `.claude/worktrees/`, `/tmp`) opened its OWN sidebar group, headed
 * by the branch slug, for as long as `git:infoBatch` took to answer — a wall
 * of fake "workspaces" on every cold start.
 *
 * Without step 3 the identity flashed — or stuck, whenever git info for that
 * cwd never loaded — on the worktree folder's own basename. Those folders are
 * named after their branch, so the top bar read "hey-2" for the `Phosphor` repo.
 */
export function projectPathFor(
  path: string,
  git?: { isWorktree?: boolean; mainRepoPath?: string },
  knownRoot?: string,
): string {
  if (git?.isWorktree && git.mainRepoPath) return git.mainRepoPath
  if (knownRoot) return knownRoot
  return /^(.*?)[/\\]\.(?:phosphor|pidex)[/\\]worktrees[/\\]/.exec(path)?.[1] ?? path
}

/**
 * Display name for "which project am I working in" — never a worktree folder.
 *
 * Use this for every surface that answers that question: the top bar chip, the
 * sidebar switcher and row badges, the home screen, the orchestrator banner.
 * The *branch* is a separate question with its own controls (`BranchControl`,
 * the row subtitle), so this name deliberately carries no branch — showing one
 * here put two answers on screen for a question the user asked once.
 *
 * Surfaces that are about a worktree *as a worktree* (`BranchPicker`,
 * `RemoveWorktreeModal`) want the folder name and should keep calling
 * `workspaceName` directly.
 */
export function projectName(
  path: string,
  git?: { isWorktree?: boolean; mainRepoPath?: string },
): string {
  return workspaceName(projectPathFor(path, git))
}

/**
 * `projectName`, plus the branch in parentheses for a linked worktree.
 *
 * Only the window title uses this: it is one line with nowhere else to put the
 * branch, unlike every in-app surface, which sits under a top bar whose chips
 * already name the folder and the branch separately.
 */
export function worktreeAwareName(
  path: string,
  git?: { isWorktree?: boolean; mainRepoPath?: string; branch?: string },
): string {
  const repo = projectName(path, git)
  if (git?.isWorktree && git.mainRepoPath && git.branch) return `${repo} (${git.branch})`
  return repo
}
