import { lstatSync, rmdirSync, type BigIntStats } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import {
  claudeProjectDirForCwd,
  piSessionsRoot,
  sessionDirForCwd,
} from '@phosphor/session-runtime/pi/pi-paths'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { isWithinFolder } from '@phosphor/shared/paths'
import { oneLine } from '@phosphor/session-runtime/ops/confirm-message'
import { validateSandboxName } from '@phosphor/session-runtime/sandboxes/folders'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { SandboxPorts } from './sandboxes'
import type { OwnerFolders } from '../config/folders-file'

export interface CleanupCandidate {
  kind: 'sandbox'
  path: string
  bytes: number
  reason: string
  identity: string
}
export const CLEANUP_LIMIT = 8
export const staleCleanup = () => new OpRefusal('bad-request', 'Cleanup plan is stale. Scan again.')

type Records = { file: OwnerFolders; configured: string[]; base: string }
type Skip = 'unavailable' | 'in-use' | 'not-empty' | 'leased' | 'plan-limit'

function inUse(p: SandboxPorts, path: string) {
  return (
    p.live(path) ||
    p.store.folders.hasArchivedFolder(path) ||
    p.store.listLanes().some((row) => isWithinFolder(row.cwd, path))
  )
}

async function absent(path: string) {
  try {
    await lstat(path)
    return false
  } catch (e) {
    return errnoIs(e, 'ENOENT')
  }
}

const stamp = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.ctimeNs}:${info.mtimeNs}`

async function candidate(
  p: SandboxPorts,
  r: Records,
  path: string,
  held = false,
): Promise<CleanupCandidate | Skip> {
  try {
    const name = basename(path)
    if (
      validateSandboxName(name) !== name ||
      oneLine(name) !== name ||
      dirname(path) !== r.base ||
      (await realpath(path)) !== path ||
      r.configured.some((root) => isWithinFolder(root, path))
    )
      return 'unavailable'
    if (
      inUse(p, path) ||
      !(await absent(sessionDirForCwd(path, piSessionsRoot(p.env, p.home)))) ||
      !(await absent(claudeProjectDirForCwd(path, p.env, p.home)))
    )
      return 'in-use'
    if (!held && p.leases.blocks(path)) return 'leased'
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory()) return 'unavailable'
    const dir = await opendir(path)
    try {
      if (await dir.read()) return 'not-empty'
    } finally {
      await dir.close()
    }
    return {
      kind: 'sandbox',
      path,
      bytes: Number(info.blocks) * 512,
      reason: 'Empty sandbox without lanes',
      identity: stamp(info),
    }
  } catch {
    return 'unavailable'
  }
}

export async function inspectCleanup(p: SandboxPorts, r: Records, signal?: AbortSignal) {
  const rows: CleanupCandidate[] = []
  const skipped: Partial<Record<Skip, number>> = {}
  for (const path of r.file.items
    .filter((item) => item.sandbox)
    .map((item) => item.path)
    .sort()) {
    signal?.throwIfAborted()
    const item = rows.length < CLEANUP_LIMIT ? await candidate(p, r, path) : 'plan-limit'
    if (typeof item === 'string') skipped[item] = (skipped[item] ?? 0) + 1
    else rows.push(item)
  }
  return { rows, skipped }
}

/** Never recursive: a newly created untracked entry must make removal fail. */
export async function applyCleanup(
  p: SandboxPorts,
  r: Records,
  rows: readonly CleanupCandidate[],
  signal: AbortSignal,
  publish: (removed: string[]) => void,
) {
  const owner = 'sandbox-maintenance'
  const held = await p.leases.take(
    owner,
    rows.map((v) => v.path),
    Infinity,
  )
  if (!('leaseId' in held)) throw staleCleanup()
  const removed: string[] = []
  try {
    for (const { path, identity } of rows) {
      signal.throwIfAborted()
      if (!r.file.items.some((item) => item.sandbox && item.path === path)) throw staleCleanup()
      const item = await candidate(p, r, path, true)
      if (typeof item === 'string' || item.identity !== identity) throw staleCleanup()
    }
    for (const { path, identity } of rows) {
      const item = await candidate(p, r, path, true)
      if (signal.aborted || typeof item === 'string' || item.identity !== identity) break
      try {
        const current = lstatSync(path, { bigint: true })
        if (!current.isDirectory() || stamp(current) !== identity || inUse(p, path)) break
        rmdirSync(path)
      } catch {
        break
      }
      removed.push(path)
    }
    return { removed: removed.length, remaining: rows.length - removed.length }
  } finally {
    try {
      if (removed.length) publish(removed)
    } finally {
      p.leases.release(owner, held.leaseId)
    }
  }
}
