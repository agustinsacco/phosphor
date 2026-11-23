import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicRecord } from '@phosphor/session-runtime/host-install/files'
import { LOCAL_SERVICE_FEATURES } from '@phosphor/session-runtime/host-install/release-source'
import { MIGRATION_DIR } from './journal'

/**
 * `<userData>/daemon-migration/service.json`: the Phosphor service Desktop
 * itself installed (M1 reported `installed`), with the features its signed
 * release and staged bundle both listed. The launch gate migrates only with
 * this record AND the running service's `machine.local` listing
 * `local-mode` and `owner-socket` (reconcile-v2 #19), so a service Desktop
 * did not install never triggers a migration.
 */

export const SERVICE_RECORD = 'service.json'
/** Unpackaged only, with `PHOSPHOR_MIGRATE=1` and `PHOSPHOR_TEST_USER_DATA`: stands in for the record. */
export const E2E_SERVICE_FEATURES_ENV = 'PHOSPHOR_E2E_SERVICE_FEATURES'

export interface ServiceRecord {
  readonly version: 1
  readonly serviceVersion: string
  readonly features: readonly string[]
  readonly machineId: string
  readonly at: string
}

export const serviceRecordPath = (userData: string) => join(userData, MIGRATION_DIR, SERVICE_RECORD)

export function writeServiceRecord(
  userData: string,
  installed: { version: string; machineId: string },
  at: string,
): void {
  const record: ServiceRecord = {
    version: 1,
    serviceVersion: installed.version,
    features: [...LOCAL_SERVICE_FEATURES],
    machineId: installed.machineId,
    at,
  }
  atomicRecord(serviceRecordPath(userData), record, 0o600)
}

export function readServiceRecord(userData: string): ServiceRecord | null {
  try {
    const value = JSON.parse(readFileSync(serviceRecordPath(userData), 'utf8')) as ServiceRecord
    return value.version === 1 && Array.isArray(value.features) ? value : null
  } catch {
    return null
  }
}

/** Whether `features` lists every feature the local service needs. */
export const hasLocalServiceFeatures = (features: readonly string[] | undefined): boolean =>
  !!features && LOCAL_SERVICE_FEATURES.every((feature) => features.includes(feature))

/**
 * The features Desktop may trust for its own service: the record's, or in a
 * gated e2e run the override's (comma-separated). Null when neither exists.
 */
export function recordedFeatures(input: {
  userData: string
  isPackaged: boolean
  migrationPermitted: boolean
  env: NodeJS.ProcessEnv
}): readonly string[] | null {
  const override = input.env[E2E_SERVICE_FEATURES_ENV]
  if (!input.isPackaged && input.migrationPermitted && override !== undefined)
    return override
      .split(',')
      .map((feature) => feature.trim())
      .filter(Boolean)
  return readServiceRecord(input.userData)?.features ?? null
}
