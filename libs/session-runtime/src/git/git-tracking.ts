import { git } from './git-exec'

/**
 * What git says about `root`: true inside a repository, false when it answers that
 * the folder is in none, null for any other failure (git missing, timed out,
 * refusing the folder). `LC_ALL=C` keeps git's sentence untranslated; an inherited
 * `GIT_DIR` or `GIT_WORK_TREE` is dropped so the folder alone decides.
 */
export async function gitTracking(root: string): Promise<boolean | null> {
  try {
    await git(root, ['rev-parse', '--git-dir'], {
      env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      isolateEnv: true,
    })
    return true
  } catch (error) {
    const stderr = (error as { stderr?: unknown } | null)?.stderr
    return typeof stderr === 'string' && /^fatal: not a git repository/m.test(stderr) ? false : null
  }
}
/**
 * False only when git answers that the folder is in no repository: a worktree needs
 * one, a lane in place does not. Any other failure answers true, so the worktree
 * step fails instead of silently running in the main checkout.
 */
export async function gitTracksFolder(root: string): Promise<boolean> {
  return (await gitTracking(root)) !== false
}
