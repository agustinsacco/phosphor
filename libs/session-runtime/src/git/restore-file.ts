import { isAbsolute, join } from 'node:path'
import { git, type GitRunner } from './git-exec'

async function baselineFile(workspacePath: string, ref: string, path: string, run = git) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '..' || part === '.' || part === '.git')
  )
    throw new Error('Expected a file path inside the workspace.')
  // Resolve once so ref changes cannot alter the object between checking and restoring.
  // Failure here is NOT evidence that this is a newly created file.
  const tree = await run(
    workspacePath,
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`],
    { trim: true },
  )
  const listing = await run(workspacePath, ['ls-tree', '-z', tree, '--', path], {
    env: { GIT_LITERAL_PATHSPECS: '1' },
  })
  const entry = listing.split('\0').find((line) => line.slice(line.indexOf('\t') + 1) === path)
  if (!entry) return { tree, object: null }
  const [, type, object] = entry.slice(0, entry.indexOf('\t')).split(' ')
  if (type !== 'blob' || !object) throw new Error('The baseline path is not a file.')
  return { tree, object }
}

/** Null means confirmed absence in a valid tree; Git/read failures propagate. */
export async function showFileAt(
  workspacePath: string,
  ref: string,
  relativePath: string,
): Promise<string | null> {
  const { object } = await baselineFile(workspacePath, ref, relativePath)
  return object === null ? null : git(workspacePath, ['cat-file', 'blob', object])
}

/** Restore one file to its baseline content (file-recovery UX). */
export async function restoreFileTo(
  workspacePath: string,
  ref: string,
  relativePath: string,
  remove: (path: string) => Promise<void>,
  run: GitRunner = git,
): Promise<{ restored: boolean; deleted: boolean }> {
  const baseline = await baselineFile(workspacePath, ref, relativePath, run)
  if (baseline.object === null) {
    // Didn't exist at baseline — the session created it; trash it.
    await remove(join(workspacePath, relativePath))
    return { restored: false, deleted: true }
  }
  // The user's staged changes belong to them. Only restore the working copy.
  await run(
    workspacePath,
    ['restore', `--source=${baseline.tree}`, '--worktree', '--', relativePath],
    {
      env: { GIT_LITERAL_PATHSPECS: '1' },
    },
  )
  return { restored: true, deleted: false }
}
