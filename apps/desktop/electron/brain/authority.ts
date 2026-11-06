import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { gitInfo } from '@phosphor/session-runtime/git/git-info'
import type { BrainPrefs } from '@phosphor/shared/brain'

/** Fresh git authority, never the display cache or a caller-supplied branch. */
export async function laneAuthority(path: string): Promise<{ scope: string; branch: string }> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096)
    throw new Error('Invalid Brain workspace')
  const cwd = await realpath(path)
  const info = await gitInfo(cwd)
  if (!info.isRepo || !info.branch || info.branch === 'HEAD')
    throw new Error('Brain requires a known Git branch')
  return { scope: await realpath(info.mainRepoPath ?? cwd), branch: info.branch }
}
export async function canonicalPrefs(prefs: BrainPrefs): Promise<BrainPrefs> {
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
