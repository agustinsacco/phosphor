/** Internal worktree path segment, including the historical `.pidex` spelling. */
export const WORKTREE_SEGMENT = /[/\\]\.(?:phosphor|pidex)[/\\]worktrees[/\\]/

/** Lexical display/prefs classification only; does not resolve or validate filesystem paths. */
export function isWorktreeFolder(path: string): boolean {
  return WORKTREE_SEGMENT.test(path)
}
