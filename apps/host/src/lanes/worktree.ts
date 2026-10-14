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
import { join, resolve } from 'node:path'
import { isLaneBranchName } from '@phosphor/shared/host-protocol'
import { git } from '@phosphor/session-runtime/git/git-exec'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'

export class LaneFolderError extends Error {}
export interface LaneFolder {
  cwd: string
  branch: string | null
  undo(): Promise<void>
}
export async function prepareLaneFolder(input: {
  root: string
  worktree: { readonly branch: string } | null
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
  const refuse = (message: string): never => {
    throw new LaneFolderError(message)
  }
  if (
    !isLaneBranchName(branch) ||
    (await optional(['check-ref-format', '--branch', branch])) !== branch
  )
    refuse('That branch name is not valid.')
  const slug = branch.replaceAll('/', '-')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(slug) || slug.includes('..'))
    refuse('That branch name is not valid.')
  let created = false
  let madeBranch = false
  let baseCommit = ''
  const path = join(root, '.phosphor', 'worktrees', slug)
  const undo = async () => {
    if (!created) return
    try {
      let registeredPath = path
      try {
        registeredPath = realpathSync.native(path)
      } catch {
        // A failed add may have registered a folder that is already gone.
      }
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
  }
  try {
    let defaultBranch = (
      await optional(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    ).replace(/^origin\//, '')
    if (!defaultBranch) {
      const names = (await run(['for-each-ref', 'refs/heads', '--format=%(refname:short)'])).split(
        '\n',
      )
      defaultBranch = names.includes('main')
        ? 'main'
        : names.includes('master')
          ? 'master'
          : await run(['rev-parse', '--abbrev-ref', 'HEAD'])
    }
    if (branch === defaultBranch) refuse('The default branch stays in the main tree.')
    const checkFolders = () => {
      for (const folder of [join(root, '.phosphor'), join(root, '.phosphor', 'worktrees')])
        directory(folder)
    }
    checkFolders()
    try {
      lstatSync(path)
      refuse('A worktree folder for that branch already exists.')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
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
    if (
      (await run(['worktree', 'list', '--porcelain']))
        .split('\n')
        .includes(`branch refs/heads/${branch}`)
    )
      refuse('That branch is checked out in another worktree.')
    const common = resolve(root, await run(['rev-parse', '--git-common-dir']))
    directory(join(common, 'info'))
    excludeWorktrees(join(common, 'info', 'exclude'))
    if (!existing) {
      const remote = await exists(`refs/remotes/origin/${defaultBranch}`)
      const base = remote
        ? `origin/${defaultBranch}`
        : (await exists(`refs/heads/${defaultBranch}`))
          ? defaultBranch
          : 'HEAD'
      baseCommit = await run(['rev-parse', '--verify', `${base}^{commit}`])
      await run(['update-ref', `refs/heads/${branch}`, baseCommit, '0'.repeat(baseCommit.length)])
      madeBranch = true
      created = true
    }
    checkFolders()
    created = true
    await run(['worktree', 'add', path, branch])
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
    appendFileSync(fd, `${ignored && !ignored.endsWith('\n') ? '\n' : ''}/.phosphor/\n`)
  } finally {
    closeSync(fd)
  }
}
