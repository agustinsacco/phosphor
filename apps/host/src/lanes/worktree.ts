import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isLaneBranchName } from '@phosphor/shared/host-protocol'
import { directory, excludeWorktrees } from '@phosphor/session-runtime/git/managed-worktree'
import { git } from '@phosphor/session-runtime/git/git-exec'
import {
  FAILED_CLEANUP_MS,
  LaneFolderError,
  worktreeGit,
  worktreeGitDeadline,
} from './worktree-git'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import {
  defaultBranchRefs,
  resolveDefaultBranch,
} from '@phosphor/session-runtime/git/default-branch'

export { LaneFolderError } from './worktree-git'
export { gitTracking, gitTracksFolder } from '@phosphor/session-runtime/git/git-tracking'

export interface LaneFolder {
  cwd: string
  branch: string | null
  undo(): Promise<void>
}
export const laneWorktreePath = (root: string, branch: string) =>
  join(root, '.phosphor', 'worktrees', branch.replaceAll('/', '-'))

export async function prepareLaneFolder(input: {
  root: string
  worktree: { readonly branch: string; readonly fresh?: true } | null
  log?: RuntimeLog
  deadline?: number
}): Promise<LaneFolder> {
  const { root, worktree, log } = input
  if (worktree === null) {
    const branch = await git(root, ['symbolic-ref', '--short', 'HEAD'], {
      env: { GIT_TERMINAL_PROMPT: '0' },
      trim: true,
      allowFail: true,
    })
    return { cwd: root, branch: isLaneBranchName(branch) ? branch : null, undo: async () => {} }
  }
  const run = worktreeGit(root, input.deadline ?? worktreeGitDeadline(), log)
  const { branch } = worktree
  const refuse = (message: string): never => {
    throw new LaneFolderError(message)
  }
  if (
    !isLaneBranchName(branch) ||
    (await run(['check-ref-format', '--branch', branch], 128).catch((error: unknown) => {
      if (error instanceof LaneFolderError) throw error
      return ''
    })) !== branch
  )
    refuse('That branch name is not valid.')
  const slug = branch.replaceAll('/', '-')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(slug) || slug.includes('..'))
    refuse('That branch name is not valid.')
  let created = false
  let worktreeCreated = false
  let madeBranch = false
  let baseCommit = ''
  const path = laneWorktreePath(root, branch)
  const logUndoFailure = (error: unknown) => {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    try {
      log?.(
        'host',
        'lane.worktree_undo_failed',
        typeof code === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(code) ? { code } : {},
      )
    } catch {
      /* Logging cannot replace the original error. */
    }
  }
  const undo = async (run = worktreeGit(root)) => {
    if (!created) return
    if (worktree.fresh) {
      try {
        // Removing the checked-out ref first makes tracked files look staged.
        if (worktreeCreated) {
          await run(['worktree', 'remove', path])
          worktreeCreated = false
        }
      } catch (error) {
        logUndoFailure(undefined)
        throw error
      } finally {
        if (madeBranch) {
          try {
            await run(['update-ref', '-d', `refs/heads/${branch}`, baseCommit])
            madeBranch = false
          } catch {
            logUndoFailure(undefined)
          }
        }
      }
      return
    }
    try {
      try {
        const leaf = lstatSync(path)
        if (leaf.isSymbolicLink() || !leaf.isDirectory()) throw new Error('folder')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      const registeredPath = join(realpathSync.native(dirname(path)), slug)
      const registered = (await run(['worktree', 'list', '--porcelain']))
        .split('\n\n')
        .find((entry) =>
          entry
            .split('\n')
            .some((line) => line === `worktree ${path}` || line === `worktree ${registeredPath}`),
        )
      if (registered) {
        if (!registered.split('\n').includes(`branch refs/heads/${branch}`)) return
        await run(['worktree', 'remove', path])
      } else {
        try {
          lstatSync(path)
          throw new Error('unregistered folder')
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
      created = false
      if (madeBranch) await run(['update-ref', '-d', `refs/heads/${branch}`, baseCommit])
    } catch (error) {
      logUndoFailure(error)
    }
  }
  try {
    const defaultBranch = await resolveDefaultBranch((args) =>
      run(args, args[0] === 'symbolic-ref' ? 1 : undefined),
    )
    if (branch === defaultBranch) {
      if (worktree.fresh) throw new LaneFolderError('That branch already exists.', 'branch-exists')
      refuse('The default branch stays in the main tree.')
    }
    const checkFolders = () => {
      for (const folder of [join(root, '.phosphor'), join(root, '.phosphor', 'worktrees')])
        directory(folder)
    }
    const checkLeafAbsent = () => {
      try {
        lstatSync(path)
        refuse('A worktree folder for that branch already exists.')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    if (!worktree.fresh) {
      checkFolders()
      checkLeafAbsent()
    }
    const exists = async (ref: string) => {
      try {
        await run(['show-ref', '--verify', '--quiet', ref], 1)
        return true
      } catch (error) {
        if (error instanceof LaneFolderError) throw error
        return false
      }
    }
    const existing = await exists(`refs/heads/${branch}`)
    if (existing && worktree.fresh)
      throw new LaneFolderError('That branch already exists.', 'branch-exists')
    if (worktree.fresh) checkLeafAbsent()
    if (
      !worktree.fresh &&
      (await run(['worktree', 'list', '--porcelain']))
        .split('\n')
        .includes(`branch refs/heads/${branch}`)
    )
      refuse('That branch is checked out in another worktree.')
    const common = resolve(root, await run(['rev-parse', '--git-common-dir']))
    if (!worktree.fresh) {
      directory(join(common, 'info'))
      excludeWorktrees(join(common, 'info', 'exclude'))
    }
    if (!existing) {
      // Without a trunk ref, a new branch starts from the HEAD commit; deletion never does.
      let base = 'HEAD'
      for (const ref of defaultBranch === null ? [] : defaultBranchRefs(defaultBranch)) {
        if (!(await exists(ref))) continue
        base = ref
        break
      }
      baseCommit = await run(['rev-parse', '--verify', `${base}^{commit}`])
      try {
        await run(['update-ref', `refs/heads/${branch}`, baseCommit, '0'.repeat(baseCommit.length)])
      } catch (error) {
        if (error instanceof LaneFolderError) throw error
        if (worktree.fresh && (await exists(`refs/heads/${branch}`)))
          throw new LaneFolderError('That branch already exists.', 'branch-exists')
        throw error
      }
      madeBranch = true
      created = true
    }
    checkFolders()
    if (worktree.fresh) {
      directory(join(common, 'info'))
      excludeWorktrees(join(common, 'info', 'exclude'))
    }
    checkLeafAbsent()
    created = true
    await run(['worktree', 'add', path, branch])
    worktreeCreated = true
    const cwd = realpathSync.native(path)
    if (cwd !== join(realpathSync.native(root), '.phosphor', 'worktrees', slug))
      throw new Error('folder')
    return { cwd, branch, undo }
  } catch (error) {
    await undo(worktreeGit(root, performance.now() + FAILED_CLEANUP_MS)).catch(() => {})
    if (error instanceof LaneFolderError) throw error
    throw new LaneFolderError('The worktree could not be created.')
  }
}
