import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLaneBranchName } from '@phosphor/shared/host-protocol'
import type { LaneGitFacts } from '@phosphor/shared/host-protocol-lane-transfer'
import { resolveDefaultBranch } from '../git/default-branch'
import { git } from '../git/git-exec'
import { gitTracking } from '../git/git-tracking'

/** No prompt may block a move: credentials come from the agent or helper, or the call fails. */
export const NETWORK_GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  LC_ALL: 'C',
}
export const NETWORK_TIMEOUT_MS = 20_000

/**
 * `git@github.com:Owner/Repo.git`, `ssh://git@github.com/Owner/Repo` and
 * `https://github.com/owner/repo` are one repository: `github.com/owner/repo`.
 * Null for anything that is not a recognizable remote (a local path, say), so
 * an unknown shape can never match by accident.
 */
export function normalizeOrigin(url: string): string | null {
  const raw = url.trim()
  let host: string
  let path: string
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(raw)
  if (scp && !raw.includes('://')) {
    host = scp[1]!
    path = scp[2]!
  } else {
    try {
      const parsed = new URL(raw)
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      return null
    }
  }
  const segments = path
    .replace(/\.git\/?$/i, '')
    .split('/')
    .filter(Boolean)
  if (!host || segments.length < 2 || segments.some((s) => s === '.' || s === '..')) return null
  return `${host}/${segments.join('/')}`.toLowerCase()
}

/** Origin of the repository holding `cwd`, normalized, or null. */
export async function repositoryOrigin(cwd: string): Promise<string | null> {
  const url = await git(cwd, ['remote', 'get-url', 'origin'], { allowFail: true, trim: true })
  return url ? normalizeOrigin(url) : null
}

export type SourceGit =
  | { kind: 'folder' }
  | { kind: 'git'; facts: LaneGitFacts; top: string; blockers: string[] }
  | { kind: 'unreadable' }

const IN_PROGRESS = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']

/**
 * Everything a move needs to know about the source checkout, read without
 * changing it. `portable` is false when a checkout elsewhere could not hold
 * the same files (submodules, LFS). A remote that cannot be reached reads as
 * not pushed, which only blocks a move into the same repository.
 */
export async function inspectSourceGit(cwd: string): Promise<SourceGit> {
  const tracking = await gitTracking(cwd)
  if (tracking === false) return { kind: 'folder' }
  if (tracking === null) return { kind: 'unreadable' }
  const run = (args: string[]) => git(cwd, args, { trim: true, env: { LC_ALL: 'C' } })
  const optional = (args: string[]) => run(args).catch(() => '')
  const blockers: string[] = []
  const commit = await optional(['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) return { kind: 'unreadable' }
  const top = await optional(['rev-parse', '--show-toplevel'])
  if (!top) return { kind: 'unreadable' }
  const symbolic = await optional(['symbolic-ref', '--short', '-q', 'HEAD'])
  const branch = isLaneBranchName(symbolic) ? symbolic : null
  if (symbolic && !branch) return { kind: 'unreadable' }
  let status: string
  try {
    status = await git(cwd, ['status', '--porcelain', '--untracked-files=all'], {
      env: { LC_ALL: 'C' },
    })
  } catch {
    return { kind: 'unreadable' }
  }
  for (const marker of IN_PROGRESS) {
    const path = await optional(['rev-parse', '--git-path', marker])
    if (path && existsSync(join(cwd, path))) {
      blockers.push('A merge, rebase or cherry-pick is in progress here.')
      break
    }
  }
  const trunk = await resolveDefaultBranch(run).catch(() => null)
  const origin = await repositoryOrigin(cwd)
  let pushed = false
  if (branch && origin) {
    const remote = await git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], {
      allowFail: true,
      trim: true,
      env: NETWORK_GIT_ENV,
      timeout: NETWORK_TIMEOUT_MS,
    })
    pushed = remote.split('\n').some((line) => line === `${commit}\trefs/heads/${branch}`)
  }
  return {
    kind: 'git',
    top,
    blockers,
    facts: {
      branch,
      commit,
      origin,
      dirty: status.trim().length > 0,
      pushed,
      trunk: branch !== null && branch === trunk,
      portable: !usesSubmodulesOrLfs(top),
    },
  }
}

function usesSubmodulesOrLfs(top: string): boolean {
  if (existsSync(join(top, '.gitmodules'))) return true
  try {
    return /filter=lfs/.test(readFileSync(join(top, '.gitattributes'), 'utf8'))
  } catch {
    return false
  }
}
