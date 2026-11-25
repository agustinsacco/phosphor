import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { readModelScans, writeModelScans } from './model-scans'

const uid = process.getuid?.()
const LANE = '11111111-1111-4111-8111-111111111111'
let directory: string
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'host-model-scans-')))
  chmodSync(directory, 0o700)
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('model scans sidecar', () => {
  it('round-trips the lanes read without a result, owner-only', () => {
    expect(readModelScans(directory, uid)).toEqual(new Map())
    writeModelScans(directory, uid, new Map([[LANE, '120:1735689600000']]))
    expect(readModelScans(directory, uid)).toEqual(new Map([[LANE, '120:1735689600000']]))
    const file = join(directory, HOST_SIDECARS.laneModelScans)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('reads a file it cannot trust, or entries it does not know, as nothing remembered', () => {
    const file = join(directory, HOST_SIDECARS.laneModelScans)
    writeFileSync(file, 'not json', { mode: 0o600 })
    expect(readModelScans(directory, uid)).toEqual(new Map())
    writeFileSync(
      file,
      JSON.stringify({ version: 1, lanes: { [LANE]: '1:2', 'not-a-lane': '1:2', x: 3 } }),
      { mode: 0o600 },
    )
    expect(readModelScans(directory, uid)).toEqual(new Map([[LANE, '1:2']]))
  })
})
