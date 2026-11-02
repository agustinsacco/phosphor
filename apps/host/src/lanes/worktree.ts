import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isLaneBranchName, LANE_FOLDER_MAX } from '@phosphor/shared/host-protocol'
import { git } from '@phosphor/session-runtime/git/git-exec'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { defaultBranchRefs, resolveDefaultBranch } from './default-branch'

export class LaneFolderError extends Error {
  constructor(
    message: string,
    /** A fresh branch may try its next name after either refusal. */
    readonly code?: 'branch-exists' | 'folder-exists',
  ) {
    super(message)
  }
}
export interface LaneFolder {
  cwd: string
  branch: string | null
  undo(): Promise<void>
}
/**
 * False only when git answers that the folder is in no repository: a worktree needs
 * one, a lane in place does not. Any other failure (git missing, timed out, refusing
 * the folder) answers true, so the worktree step fails instead of silently running
 * in the main checkout. `LC_ALL=C` keeps git's sentence untranslated.
 */
export async function gitTracksFolder(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--git-dir'], {
      env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    })
    return true
  } catch (error) {
    const stderr = (error as { stderr?: unknown } | null)?.stderr
    return !(typeof stderr === 'string' && /^fatal: not a git repository/m.test(stderr))
  }
}
export async function prepareLaneFolder(input: {
  root: string
  worktree: { readonly branch: string; readonly fresh?: true } | null
  log?: RuntimeLog
}): Promise<LaneFolder> {
  const { root, worktree, log } = input
  const run = (args: string[]) => git(root, args, { env: { GIT_TERMINAL_PROMPT: '0' }, trim: true })
  const optional = (args: string[]) => run(args).catch(() => '')
  if (worktree === null) {
    const branch = await optional(['symbolic-ref', '--short', 'HEAD'])
    return { cwd: root, branch: isLaneBranchName(branch) ? branch : null, undo: async () => {} }
  }
  const { branch } = worktree
  const refuse = (message: string, code?: LaneFolderError['code']): never => {
    throw new LaneFolderError(message, code)
  }
  if (
    !isLaneBranchName(branch) ||
    (await optional(['check-ref-format', '--branch', branch])) !== branch
  )
    refuse('That branch name is not valid.')
  const slug = laneFolderSlug(branch) ?? refuse('That branch name is not valid.')
  let created = false
  let worktreeCreated = false
  let madeBranch = false
  let baseCommit = ''
  const path = join(root, '.phosphor', 'worktrees', slug)
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
  const undo = async () => {
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
    const defaultBranch = await resolveDefaultBranch(run)
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
        refuse('A worktree folder for that branch already exists.', 'folder-exists')
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
        await run(['show-ref', '--verify', '--quiet', ref])
        return true
      } catch {
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
    await undo()
    if (error instanceof LaneFolderError) throw error
    throw new LaneFolderError('The worktree could not be created.')
  }
}

/** The worktree folder name for a branch, or null when the branch cannot have one. */
export function laneFolderSlug(branch: string): string | null {
  const slug = branch.replaceAll('/', '-')
  return slug.length <= LANE_FOLDER_MAX &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) &&
    !slug.includes('..')
    ? slug
    : null
}

function directory(path: string): void {
  try {
    mkdirSync(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('folder')
}
function excludeWorktrees(path: string): void {
  const cap = 1024 * 1024
  const regular = (fd: number) => {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > cap) throw new Error('exclude')
  }
  let ignored = ''
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    regular(fd)
    const buffer = Buffer.alloc(cap)
    let size = 0
    while (size < cap) {
      const count = readSync(fd, buffer, size, cap - size, size)
      if (!count) break
      size += count
    }
    regular(fd)
    ignored = buffer.toString('utf8', 0, size)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  if (ignored.split(/\r?\n/).includes('/.phosphor/')) return
  fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o644,
  )
  try {
    regular(fd)
    const entry = `${ignored && !ignored.endsWith('\n') ? '\n' : ''}/.phosphor/\n`
    if (fstatSync(fd).size + Buffer.byteLength(entry) > cap) throw new Error('exclude')
    appendFileSync(fd, entry)
  } finally {
    closeSync(fd)
  }
}
