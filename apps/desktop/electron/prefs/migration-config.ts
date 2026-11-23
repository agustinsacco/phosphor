import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { atomicRecord } from '@phosphor/session-runtime/host-install/files'
import { readBackupManifest } from '../local-machine/migration/backup'

export type ConfigRecord = Record<string, unknown>
export function asRecord(v: unknown): ConfigRecord {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('Invalid migration preferences.')
  return v as ConfigRecord
}
export function strings(v: unknown): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || !v.every((s): s is string => typeof s === 'string'))
    throw new Error('Invalid migration preference list.')
  return v
}
export function hasFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw new Error('Expected a regular migration file.')
    return true
  } catch (e) {
    if (errnoIs(e, 'ENOENT')) return false
    throw e
  }
}
export function liveConfig(userData: string): ConfigRecord {
  const path = join(userData, 'config.json')
  return hasFile(path) ? asRecord(JSON.parse(readFileSync(path, 'utf8'))) : {}
}
export function writeConfig(userData: string, config: ConfigRecord): void {
  atomicRecord(join(userData, 'config.json'), config, 0o600)
}

/** A missing config is valid only when the verified backup recorded no config. */
export function backupConfig(backupDir: string, migrationId: string): ConfigRecord {
  const manifest = readBackupManifest(backupDir)
  if (!manifest || manifest.migrationId !== migrationId)
    throw new Error('The migration backup is missing or invalid.')
  const entry = manifest.entries.find((e) => e.name === 'config.json')
  const path = join(backupDir, 'config.json')
  if (!entry && !hasFile(path)) return {}
  if (!entry || !hasFile(path)) throw new Error('The saved preferences are missing or invalid.')
  const bytes = readFileSync(path)
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
    throw new Error('The saved preferences failed verification.')
  return asRecord(JSON.parse(bytes.toString('utf8')))
}
