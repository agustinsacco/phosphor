import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
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
      const registered = (await run(['worktree', 'list', '--porcelain']))
        .split('\n')
        .includes(`worktree ${path}`)
      if (registered) await run(['worktree', 'remove', path])
      else {
        try {
          lstatSync(path)
          throw new Error('unregistered folder')
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
      created = false
      if (madeBranch && (await optional(['rev-parse', `refs/heads/${branch}`])) === baseCommit)
        await run(['branch', '-D', branch])
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
    for (const folder of [join(root, '.phosphor'), join(root, '.phosphor', 'worktrees')]) {
      try {
        mkdirSync(folder)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      const stat = lstatSync(folder)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('folder')
    }
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
    const exclude = join(common, 'info', 'exclude')
    mkdirSync(join(common, 'info'), { recursive: true })
    let ignored = ''
    try {
      ignored = readFileSync(exclude, 'utf8')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (!ignored.split(/\r?\n/).includes('/.phosphor/'))
      appendFileSync(exclude, `${ignored && !ignored.endsWith('\n') ? '\n' : ''}/.phosphor/\n`)
    if (existing) {
      created = true
      await run(['worktree', 'add', path, branch])
    } else {
      const remote = await exists(`refs/remotes/origin/${defaultBranch}`)
      const base = remote
        ? `origin/${defaultBranch}`
        : (await exists(`refs/heads/${defaultBranch}`))
          ? defaultBranch
          : 'HEAD'
      baseCommit = await run(['rev-parse', '--verify', `${base}^{commit}`])
      // Pin the start point so a concurrent ref update cannot change what undo owns.
      madeBranch = true
      created = true
      await run(['worktree', 'add', '-b', branch, path, baseCommit])
    }
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
