import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { LANE_TRANSFER_LIMITS as LIMIT } from '@phosphor/shared/host-protocol-lane-transfer'

/**
 * Bundles in flight, under `<state>/lane-transfer/{exports,imports}/`: private to this user,
 * never inside a repository, and gone after an hour or a restart. A transfer
 * id is 128 random bits, never a path.
 */
export interface Staged {
  path: string
  started: number
}

export function createStaging(root: string, now: () => number = Date.now) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('lane-transfer folder')
  // Nothing survives a restart: an unfinished transfer cannot be resumed.
  for (const name of readdirSync(root)) rmSync(join(root, name), { force: true, recursive: true })
  const entries = new Map<string, Staged>()
  function sweep(): void {
    for (const [id, entry] of entries)
      if (now() - entry.started > LIMIT.lifetimeMs) discard(id)
  }
  function discard(id: string): void {
    const entry = entries.get(id)
    entries.delete(id)
    if (entry) rmSync(entry.path, { force: true })
  }
  return {
    /** Reserve a new staged file, or null when `max` transfers are already open. */
    create(max: number): { id: string; path: string } | null {
      sweep()
      if (entries.size >= max) return null
      const id = randomBytes(16).toString('hex')
      const path = join(root, id)
      entries.set(id, { path, started: now() })
      return { id, path }
    },
    get(id: string): Staged | undefined {
      sweep()
      return entries.get(id)
    },
    discard,
    close(): void {
      for (const id of [...entries.keys()]) discard(id)
    },
  }
}
export type Staging = ReturnType<typeof createStaging>
