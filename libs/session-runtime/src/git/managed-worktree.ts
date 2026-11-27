import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
} from 'node:fs'
import { join } from 'node:path'
import type { AddWorktreeBranch } from '@phosphor/shared/models'
import { git, type GitRunner } from './git-exec'

export const worktreeRootFor = (repo: string) => join(repo, '.phosphor', 'worktrees')

export async function addGitWorktree(
  repo: string,
  path: string,
  branch: AddWorktreeBranch,
  run: GitRunner = git,
) {
  const args = ['worktree', 'add']
  if (branch.kind === 'new') {
    args.push('-b', branch.branch!)
    if (branch.noTrack) args.push('--no-track')
  }
  await run(repo, [...args, '--', path, branch.kind === 'new' ? branch.base : branch.branch])
}

export const removeGitWorktree = (
  repo: string,
  path: string,
  force: boolean,
  run: GitRunner = git,
) => run(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path])

export function directory(path: string): void {
  try {
    mkdirSync(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('folder')
}
export function excludeWorktrees(path: string): void {
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
