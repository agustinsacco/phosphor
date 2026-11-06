import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { gitInfo } from '@phosphor/session-runtime/git/git-info'
import { query as validateQuery } from '@phosphor/memory-engine/validation'
import type { BrainPrefs, BrainQuery } from '@phosphor/shared/brain'

/** Fresh git authority, never the display cache or a caller-supplied branch. */
export async function laneAuthority(path: string): Promise<{ scope: string; branch: string }> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096)
    throw new Error('Invalid Brain workspace')
  const cwd = await realpath(path)
  const info = await gitInfo(cwd)
  if (!info.isRepo || !info.branch || info.branch === 'HEAD')
    throw new Error('Brain requires a known Git branch')
  return {
    scope: await realpath(
      info.mainRepoPath ??
        (await git(cwd, ['rev-parse', '--show-toplevel'], {
          trim: true,
          isolateEnv: true,
          maxBuffer: 4096,
        })),
    ),
    branch: info.branch,
  }
}
export async function canonicalPrefs(prefs: BrainPrefs): Promise<BrainPrefs> {
  fields(prefs, ['enabled', 'recall', 'workspaces', 'processor', 'retentionDays'])
  if (prefs.processor !== null) fields(prefs.processor, ['provider', 'id'])
  if (!prefs || !Array.isArray(prefs.workspaces) || prefs.workspaces.length > 100)
    throw new Error('Invalid Brain preferences')
  return {
    ...prefs,
    workspaces: [
      ...new Set(
        await Promise.all(prefs.workspaces.map(async (path) => (await laneAuthority(path)).scope)),
      ),
    ],
  }
}
export function bounded<T>(value: T, bytes = 256_000): T {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > bytes)
    throw new Error('Brain input exceeds limit')
  return value
}
export function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/.test(value))
    throw new Error('Invalid Brain identifier')
  return value
}

export function fields(value: unknown, allowed: string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error('Invalid Brain field')
}
export function brainQuery(value: BrainQuery): BrainQuery {
  fields(value, [
    'query',
    'branch',
    'entityIds',
    'scopes',
    'validAt',
    'knownAt',
    'limit',
    'tokenBudget',
    'mode',
  ])
  validateQuery(value)
  return value
}
