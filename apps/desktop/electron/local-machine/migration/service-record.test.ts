import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  E2E_SERVICE_FEATURES_ENV,
  hasLocalServiceFeatures,
  readServiceRecord,
  recordedFeatures,
  serviceRecordPath,
  writeServiceRecord,
} from './service-record'

let userData: string
beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'm3-record-'))
})
afterEach(() => rmSync(userData, { recursive: true, force: true }))

const MACHINE = '00000000-0000-4000-8000-0000000000bb'

describe('service record', () => {
  it('records the service Desktop installed with both local features, privately', () => {
    expect(readServiceRecord(userData)).toBeNull()
    writeServiceRecord(
      userData,
      { version: '0.3.0', machineId: MACHINE },
      '2026-11-23T10:00:00.000Z',
    )
    const record = readServiceRecord(userData)!
    expect(record).toMatchObject({ serviceVersion: '0.3.0', machineId: MACHINE })
    expect(hasLocalServiceFeatures(record.features)).toBe(true)
    expect(statSync(serviceRecordPath(userData)).mode & 0o777).toBe(0o600)
  })

  it('needs both local-mode and owner-socket', () => {
    expect(hasLocalServiceFeatures(['local-mode'])).toBe(false)
    expect(hasLocalServiceFeatures(undefined)).toBe(false)
    expect(hasLocalServiceFeatures(['owner-socket', 'local-mode', 'ops'])).toBe(true)
  })

  it('takes the e2e override only unpackaged with the migration permitted', () => {
    const env = { [E2E_SERVICE_FEATURES_ENV]: 'local-mode, owner-socket' }
    const input = { userData, env, isPackaged: false, migrationPermitted: true }
    expect(recordedFeatures(input)).toEqual(['local-mode', 'owner-socket'])
    expect(recordedFeatures({ ...input, migrationPermitted: false })).toBeNull()
    expect(recordedFeatures({ ...input, isPackaged: true })).toBeNull()
  })
})
