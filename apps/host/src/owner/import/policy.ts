/**
 * The `policy` section: context defaults, naming and directives go into the
 * Host config through its one settings writer; Headroom's switch into its
 * sidecar.
 */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import {
  HOST_FILE_POLICY,
  saveSettingsFile,
  settingsFile,
  withSettingsFileLock,
} from '@phosphor/session-runtime/pi/settings-file'
import { validateHostConfig } from '../../config/schema'
import { writeHeadroomPreference } from '../../session/headroom'
import type { MigrationImporter } from '../migrate'
import { refuseImport, type ImportPorts } from './ports'
import { keepFile, putBackFile } from './snapshot'

export const POLICY_REFUSALS = {
  invalid: 'This Mac’s agent policy is not valid for the Phosphor service.',
} as const

type PolicySection = Parameters<MigrationImporter<'policy'>['apply']>[0]

/** The config with This Mac's policy; merge only fills what the daemon has not set. */
export function importedPolicy(
  raw: Readonly<Record<string, unknown>>,
  section: PolicySection,
  merge: boolean,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw }
  const set = (key: string, value: unknown) => {
    if (merge && raw[key] !== undefined) return
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  set('contextBudget', section.contextBudget || undefined)
  set('contextFiles', section.contextFiles)
  set('autoNameLanes', section.autoNameLanes)
  set('agentDirectives', section.agentDirectives)
  const byProject = {
    ...section.directivesByFolder,
    ...(merge ? (raw.agentDirectivesByProject as Record<string, unknown> | undefined) : {}),
  }
  if (Object.keys(byProject).length > 0) next.agentDirectivesByProject = byProject
  else delete next.agentDirectivesByProject
  return next
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return false
    throw error
  }
}

export function policyImporter(ports: ImportPorts): MigrationImporter<'policy'> {
  const headroom = join(ports.stateDirectory, HOST_SIDECARS.headroom)
  return {
    async apply(section, { merge }) {
      await withSettingsFileLock(ports.configPath, async () => {
        const file = settingsFile(ports.configPath, HOST_FILE_POLICY)
        const next = importedPolicy(file.raw, section, merge)
        if (!validateHostConfig(next).ok) throw refuseImport('bad-request', POLICY_REFUSALS.invalid)
        await saveSettingsFile(ports.configPath, next, file.revision, () => true, HOST_FILE_POLICY)
      })
      if (!merge || !(await exists(headroom)))
        writeHeadroomPreference(ports.stateDirectory, ports.uid, section.headroom)
    },
    async snapshot(into) {
      await keepFile(ports.configPath, into, 'config')
      await keepFile(headroom, into, 'headroom')
    },
    async restore(from) {
      await withSettingsFileLock(ports.configPath, () =>
        putBackFile(ports.configPath, from, 'config'),
      )
      await putBackFile(headroom, from, 'headroom')
    },
  }
}
