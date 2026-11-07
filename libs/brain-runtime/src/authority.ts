import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { query as validateQuery } from '@phosphor/memory-engine/validation'
import type { BrainPrefs, BrainQuery } from '@phosphor/shared/brain'

/** Fresh local authority. Only a confirmed non-repository has no branch. */
export async function laneAuthority(
  path: string,
): Promise<{ scope: string; branch: string | null }> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096)
    throw new Error('Invalid Brain workspace')
  const cwd = await realpath(path)
  if (!(await stat(cwd)).isDirectory()) throw new Error('Brain workspace must be a directory')
  const options = { trim: true, isolateEnv: true, maxBuffer: 16_384, env: { LC_ALL: 'C' } }
  let location: string
  try {
    location = await git(
      cwd,
      ['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'],
      options,
    )
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown }
    // Broken metadata, permissions and a missing git executable are NOT proof
    // of a plain folder. Never turn unavailable Git authority into global recall.
    if (
      failure.code === 128 &&
      typeof failure.stderr === 'string' &&
      /^fatal: not a git repository \((?:or any of the parent directories|or any parent up to mount point [^\n]+)\)/.test(
        failure.stderr,
      )
    )
      return { scope: cwd, branch: null }
    throw new Error('Brain workspace Git authority unavailable', { cause: error })
  }
  const [gitDir, commonDirRaw, root, ...extra] = location.split('\n')
  if (!gitDir || !commonDirRaw || !root || extra.length)
    throw new Error('Ambiguous Brain workspace Git authority')
  const commonDir = resolve(cwd, commonDirRaw)
  const scope = await realpath(gitDir === commonDir ? root : dirname(commonDir))
  const branch = await git(cwd, ['symbolic-ref', '--short', 'HEAD'], options).catch(() => '')
  if (!branch || branch === 'HEAD') throw new Error('Brain requires a known Git branch')
  return { scope, branch }
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
