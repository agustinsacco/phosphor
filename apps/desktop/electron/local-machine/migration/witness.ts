import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { atomicRecord, readBounded } from '@phosphor/session-runtime/host-install/files'

/**
 * The session witness (gate G8): size, mtime in nanoseconds and inode of every
 * transcript the migration plans to hand over, plus each archived transcript.
 * Only those files, never the whole sessions root, because pi run by hand
 * writes there too (V-D1.R5). Taken after the plan and re-checked before the
 * commit point: the migration must never have changed a transcript.
 */

export const WITNESS_FILE = 'sessions-witness.json'
const WITNESS_MAX_BYTES = 16 * 1024 * 1024

export type WitnessEntry =
  | {
      readonly path: string
      readonly size: number
      readonly mtimeNs: string
      readonly ino: string
    }
  | { readonly path: string; readonly missing: true }

export interface SessionWitness {
  readonly version: 1
  readonly entries: readonly WitnessEntry[]
}

function entryFor(path: string): WitnessEntry {
  try {
    const info = lstatSync(path, { bigint: true })
    return {
      path,
      size: Number(info.size),
      mtimeNs: info.mtimeNs.toString(),
      ino: info.ino.toString(),
    }
  } catch (error) {
    if (errnoIs(error, 'ENOENT', 'ENOTDIR')) return { path, missing: true }
    throw error
  }
}

/** The witness of `paths`, sorted and de-duplicated so equal sets compare equal. */
export function takeWitness(paths: readonly string[]): SessionWitness {
  return { version: 1, entries: [...new Set(paths)].sort().map(entryFor) }
}

/** Paths whose entry differs between two witnesses, or that only one of them holds. */
export function witnessChanges(before: SessionWitness, after: SessionWitness): string[] {
  const key = (e: WitnessEntry) => JSON.stringify(e)
  const was = new Map(before.entries.map((e) => [e.path, key(e)]))
  const now = new Map(after.entries.map((e) => [e.path, key(e)]))
  const changed = new Set<string>()
  for (const [path, value] of was) if (now.get(path) !== value) changed.add(path)
  for (const path of now.keys()) if (!was.has(path)) changed.add(path)
  return [...changed].sort()
}

export function writeWitness(backupDir: string, witness: SessionWitness): void {
  atomicRecord(join(backupDir, WITNESS_FILE), witness, 0o600)
}

export function readWitness(backupDir: string): SessionWitness | null {
  try {
    const value = JSON.parse(
      readBounded(join(backupDir, WITNESS_FILE), WITNESS_MAX_BYTES),
    ) as SessionWitness
    return value.version === 1 && Array.isArray(value.entries) ? value : null
  } catch {
    return null
  }
}
