import { abortMergeAndCollectConflicts, dirtyCount, git, type GitRunner } from './git-exec'

export type MergeOptions = { run?: GitRunner; keepConflicts?: true }

/** Desktop aborts an unsuccessful merge; Host agents can resolve the normal Git state. */
export async function mergeWithConflicts(cwd: string, args: string[], options: MergeOptions) {
  const run = options.run ?? git
  try {
    await run(cwd, ['merge', ...args])
    return null
  } catch (error) {
    if (!options.keepConflicts) return abortMergeAndCollectConflicts(cwd)
    const paths = (await run(cwd, ['diff', '--name-only', '-z', '--diff-filter=U']))
      .split('\0')
      .filter(Boolean)
    if (
      paths.length === 0 &&
      !(await run(cwd, ['rev-parse', '--verify', 'MERGE_HEAD'], { allowFail: true }))
    )
      throw error
    return paths
  }
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * Rename a branch, including one checked out in a linked worktree.
 *
 * This exists because a chat's branch is now cut before its name is known. The
 * naming model costs ~13s, and waiting for it is what made "new chat" feel
 * hung, so the branch is cut immediately from a slug of the first message and
 * brought into agreement with the generated title afterwards.
 *
 * `git branch -m` is safe on a branch that a linked worktree has checked out —
 * git rewrites that worktree's HEAD, so the live pi session running there is
 * undisturbed (its cwd, which is what binds it to its transcript, never
 * moves). The worktree *folder* keeps its original slug on purpose: moving it
 * would move a live session's cwd out from under it.
 *
 * Never throws for the ordinary refusals — a rename is cosmetic, and a chat
 * that is already running must not surface an error because its branch could
 * not be retitled.
 */
export async function renameBranch(
  repoPath: string,
  from: string,
  to: string,
  run: GitRunner = git,
): Promise<{ renamed: boolean; branch: string }> {
  if (from === to) return { renamed: false, branch: from }
  if (!NAME_PATTERN.test(to) || to.includes('..')) {
    return { renamed: false, branch: from }
  }
  try {
    // No `-M`: a plain `-m` refuses to clobber an existing branch, which is
    // the behaviour we want if the caller's dedupe raced another session.
    await run(repoPath, ['branch', '-m', '--', from, to])
    return { renamed: true, branch: to }
  } catch {
    return { renamed: false, branch: from }
  }
}

/** Stage everything and commit in the worktree. Refuses empty messages. */
export async function commitAll(
  worktreePath: string,
  message: string,
  run: GitRunner = git,
): Promise<{ sha: string }> {
  if (!message.trim()) throw new Error('Commit message must not be empty.')
  await run(worktreePath, ['add', '-A'])
  await run(worktreePath, ['commit', '-m', message])
  return { sha: (await run(worktreePath, ['rev-parse', 'HEAD'])).trim() }
}

/**
 * Merge `branch` into the main tree's current branch. Preflight requires the
 * main tree to be clean (we never checkout or stash for the user); a conflict
 * aborts immediately so the repo is never left mid-merge.
 */
export async function mergeBranch(
  repoPath: string,
  branch: string,
  options: MergeOptions = {},
): Promise<
  | { merged: true; sha: string }
  | { merged: false; reason: 'dirty'; dirtyCount: number }
  | { merged: false; reason: 'conflict'; conflicts: string[] }
> {
  const run = options.run ?? git
  const dirty = await dirtyCount(repoPath, run)
  if (dirty > 0) {
    return { merged: false, reason: 'dirty', dirtyCount: dirty }
  }
  const conflicts = await mergeWithConflicts(repoPath, ['--no-ff', '--no-edit', branch], options)
  if (conflicts) return { merged: false, reason: 'conflict', conflicts }
  return { merged: true, sha: (await run(repoPath, ['rev-parse', 'HEAD'])).trim() }
}
