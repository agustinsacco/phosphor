import type { GitInfo } from '@shared/models'

/**
 * The `--append-system-prompt` block Phosphor adds for worktree sessions.
 *
 * pi already ends its system prompt with one `Current working directory: …`
 * line, and that line is correct. It is not enough: when the worktree sits
 * *inside* its own main checkout — which is exactly where Phosphor puts them,
 * `<repo>/.phosphor/worktrees/<name>` — the cwd string contains the main
 * checkout as a prefix, and a model absolutising a relative path has been
 * observed to trim the `.phosphor/worktrees/<name>` segment back off. The
 * shortened path exists and opens, so the mistake returns another branch's
 * code instead of an error (session 01a02ca0: one of two reads).
 *
 * So this says the part pi's line leaves implicit: the prefix is load-bearing
 * and the main checkout is a different branch. `pi-ext/worktree-paths.ts` is
 * the backstop that makes it loud when a model does it anyway.
 *
 * Nothing is appended for ordinary (non-worktree) sessions — pi's own line
 * already covers them, and every token here is spent on every request.
 */
export function worktreePromptBlock(cwd: string, git: GitInfo): string | undefined {
  if (!git.isRepo || !git.isWorktree || !git.mainRepoPath) return undefined
  if (git.mainRepoPath === cwd) return undefined

  return [
    '<phosphor_workspace>',
    `Working directory: ${cwd}`,
    `This session runs in a git worktree. The repository's main checkout is at ` +
      `${git.mainRepoPath} and is on a DIFFERENT branch.`,
    '- Resolve every relative path against the working directory above.',
    '- When a tool wants an absolute path, build it by prefixing the working directory',
    `  verbatim. Never shorten it to ${git.mainRepoPath} — files there belong to another`,
    '  branch, and reading them returns stale code with no error.',
    '</phosphor_workspace>',
  ].join('\n')
}
