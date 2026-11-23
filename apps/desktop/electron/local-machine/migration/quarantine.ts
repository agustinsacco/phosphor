import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { asRecord, hasFile, strings, type ConfigRecord } from '../../prefs/migration-config'
import { isHostSessionKey } from './rekey'

export type RoutinesFile = 'routines.sqlite' | 'routines-dev.sqlite'
export const legacyKeys = [
  'recentWorkspaces',
  'lastWorkspacePath',
  'lastSessionPath',
  'seenSessions',
  'rewoundSessions',
  'agentDirectives',
  'agentDirectivesByProject',
  'contextBudget',
  'contextFiles',
  'headroom',
  'claudeAccounts',
] as const
export const restoreKeys = [
  ...legacyKeys,
  'lastLocal',
  'localRuntime',
  'drafts',
  'sessionOrder',
  'collapsedWorkspaces',
  'pinnedSessions',
  'laneMarkers',
] as const

export function quarantineConfig(config: ConfigRecord): ConfigRecord {
  const next = { ...config }
  for (const key of legacyKeys) delete next[key]
  next.pinnedSessions = strings(config.pinnedSessions).filter(isHostSessionKey)
  next.laneMarkers = Object.fromEntries(
    Object.entries(asRecord(config.laneMarkers ?? {})).filter(([k]) => isHostSessionKey(k)),
  )
  if (config.lanes) {
    const lanes = { ...asRecord(config.lanes) }
    delete lanes.autoName
    next.lanes = lanes
  }
  return next
}

export function routineFiles(userData: string, file: RoutinesFile): string[] {
  return ['', '-wal', '-shm'].map((suffix) => join(userData, file + suffix))
}
export const migratedFile = (file: string, id: string) => `${file}.migrated-${id}`

/** At the single-instance launch gate, before any Desktop routines connection opens. */
export function parkRoutines(userData: string, file: RoutinesFile, id: string): void {
  for (const path of routineFiles(userData, file)) {
    const parked = migratedFile(path, id)
    if (!hasFile(parked) && hasFile(path)) renameSync(path, parked)
  }
}
