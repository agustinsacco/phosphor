/** Internal worktree path segment, including the historical `.pidex` spelling. */
export const WORKTREE_SEGMENT = /[/\\]\.(?:phosphor|pidex)[/\\]worktrees[/\\]/

/**
 * A worktree is a branch of a workspace, never a workspace of its own, so it is
 * never persisted or listed as one. Lexical display/prefs classification only;
 * does not resolve or validate filesystem paths.
 */
export function isWorktreeFolder(path: string): boolean {
  return WORKTREE_SEGMENT.test(path)
}
