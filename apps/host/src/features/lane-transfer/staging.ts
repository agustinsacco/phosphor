import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { LANE_TRANSFER_LIMITS as LIMIT } from '@phosphor/shared/host-protocol-lane-transfer'
import type { LaneJobStatus } from '@phosphor/shared/host-protocol-lane-transfer-calls'

/**
 * Bundles in flight, under `<state>/lane-transfer/{exports,imports}/`: private
 * to this user, never inside a repository, and gone after an hour or a
 * restart. A transfer id is 128 random bits, never a path. Each one carries
 * its job's status, which outlives the file so a client can still ask.
 */
export interface Staged {
  path: string
  started: number
  status: LaneJobStatus<unknown>
}

export function createStaging(root: string, now: () => number = Date.now) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('lane-transfer folder')
  // Nothing survives a restart: an unfinished transfer cannot be resumed.
  for (const name of readdirSync(root)) rmSync(join(root, name), { force: true, recursive: true })
  const entries = new Map<string, Staged>()
  function sweep(): void {
    for (const [id, entry] of entries) if (now() - entry.started > LIMIT.lifetimeMs) discard(id)
  }
  function discard(id: string): void {
    const entry = entries.get(id)
    entries.delete(id)
    if (entry) rmSync(entry.path, { force: true })
  }
  return {
    /** Reserve a new staged file, or null when `max` transfers are still running. */
    create(max: number): { id: string; entry: Staged } | null {
      sweep()
      const running = [...entries.values()].filter(
        (e) => ('state' in e.status && e.status.state === 'running') || existsSync(e.path),
      )
      if (running.length >= max) return null
      const id = randomBytes(16).toString('hex')
      const entry: Staged = { path: join(root, id), started: now(), status: { state: 'running' } }
      entries.set(id, entry)
      return { id, entry }
    },
    get(id: string): Staged | undefined {
      sweep()
      return entries.get(id)
    },
    /** Run `job` as this transfer's status; a refusal's sentence is its answer. */
    track(entry: Staged, job: Promise<unknown>, refusal: (error: unknown) => string[]): void {
      // Both outcomes are handled here, so the chain itself cannot reject.
      void job.then(
        (value) => {
          entry.status = { state: 'done', value }
        },
        (error: unknown) => {
          entry.status = { blockers: refusal(error) }
          rmSync(entry.path, { force: true })
        },
      )
    },
    /** Drop the bytes but keep the answer. */
    release(id: string): void {
      const entry = entries.get(id)
      if (entry) rmSync(entry.path, { force: true })
    },
    discard,
    close(): void {
      for (const id of [...entries.keys()]) discard(id)
    },
  }
}
export type Staging = ReturnType<typeof createStaging>
