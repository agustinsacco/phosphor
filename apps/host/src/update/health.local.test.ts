import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicRecord } from '@phosphor/session-runtime/host-install/files'
import {
  HEARTBEAT_RECENT_MS,
  UPDATE_RESULT_TTL_MS,
  healthBaseline,
  readUpdateResult,
  restartedHealthy,
  writeUpdateResult,
} from './health'

const uid = process.getuid?.()
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function folders(marker: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'host-health-'))
  roots.push(root)
  const state = join(root, 'state')
  const config = join(root, 'config')
  mkdirSync(state, { mode: 0o700 })
  mkdirSync(config, { mode: 0o700 })
  if (marker)
    writeFileSync(
      join(config, 'local-mode.json'),
      JSON.stringify({ version: 1, enabledAt: '2026-11-23T00:00:00.000Z', shellEnvironment: true }),
      { mode: 0o600 },
    )
  const beat = (version: string, at: number) =>
    atomicRecord(join(state, 'run.json'), { version, pid: 1, startedAt: at, acceptedAt: at }, 0o600)
  const ready = (version: string, at: number) =>
    atomicRecord(
      join(state, 'local.json'),
      {
        version: 1,
        pid: 1,
        hostVersion: version,
        machineId: randomUUID(),
        socket: '/tmp/phosphor-d4-test.sock',
        startedAt: at,
        localReadyAt: at,
      },
      0o600,
    )
  return { state, config, beat, ready }
}

const AFTER = 1_000_000

describe('the combined health rule', () => {
  it('keeps the heartbeat rule for a Host without the local-mode marker', () => {
    const f = folders(false)
    const baseline = healthBaseline(f.state, f.config, uid, AFTER)
    expect(baseline).toEqual({ after: AFTER, local: false, heartbeat: false })
    f.ready('1.2.3', AFTER + 1)
    expect(restartedHealthy(baseline, '1.2.3', f.state, uid, AFTER + 2)).toBe(false)
    f.beat('1.2.3', AFTER + 1)
    expect(restartedHealthy(baseline, '1.2.3', f.state, uid, AFTER + 2)).toBe(true)
  })

  it('passes an offline local daemon on local.json from the new version after the restart', () => {
    const f = folders(true)
    f.beat('1.0.0', AFTER - HEARTBEAT_RECENT_MS - 1)
    const baseline = healthBaseline(f.state, f.config, uid, AFTER)
    expect(baseline).toEqual({ after: AFTER, local: true, heartbeat: false })
    f.ready('1.0.0', AFTER + 1)
    expect(restartedHealthy(baseline, '1.2.3', f.state, uid, AFTER + 2)).toBe(false)
    f.ready('1.2.3', AFTER - 1)
    expect(restartedHealthy(baseline, '1.2.3', f.state, uid, AFTER + 2)).toBe(false)
    f.ready('1.2.3', AFTER + 1)
    expect(restartedHealthy(baseline, '1.2.3', f.state, uid, AFTER + 2)).toBe(true)
  })

  it('also needs a new heartbeat when the old daemon had one within ten minutes', () => {
    const f = folders(true)
    f.beat('1.0.0', AFTER - HEARTBEAT_RECENT_MS)
    const baseline = healthBaseline(f.state, f.config, uid, AFTER)
    expect(baseline.heartbeat).toBe(true)
    f.ready('1.2.3', AFTER + 1)
    expect(restartedHealthy(baseline, '1.2.3', f.state, uid, AFTER + 2)).toBe(false)
    f.beat('1.2.3', AFTER + 1)
    expect(restartedHealthy(baseline, '1.2.3', f.state, uid, AFTER + 2)).toBe(true)
  })

  it('treats an unusable marker as local, so the new daemon must still answer locally', () => {
    const f = folders(false)
    writeFileSync(join(f.config, 'local-mode.json'), '{', { mode: 0o600 })
    expect(healthBaseline(f.state, f.config, uid, AFTER).local).toBe(true)
  })
})

describe('update-result.json', () => {
  it('records the outcome for the next daemon and drops it after a day', () => {
    const f = folders(true)
    const at = new Date(AFTER).toISOString()
    writeUpdateResult(f.state, uid, { from: '1.0.0', to: '1.2.3', outcome: 'rolled-back', at })
    expect(readUpdateResult(f.state, uid, AFTER + UPDATE_RESULT_TTL_MS)).toEqual({
      from: '1.0.0',
      to: '1.2.3',
      outcome: 'rolled-back',
      at,
    })
    expect(readUpdateResult(f.state, uid, AFTER + UPDATE_RESULT_TTL_MS + 1)).toBeNull()
    expect(existsSync(join(f.state, 'update-result.json'))).toBe(false)
  })

  it('never fails an update over a missing state folder, and reads a bad record as none', () => {
    const f = folders(true)
    const result = { from: '1.0.0', to: '1.2.3', outcome: 'updated' as const, at: 'x' }
    expect(() => writeUpdateResult(join(f.state, 'missing'), uid, result)).not.toThrow()
    writeUpdateResult(f.state, uid, result)
    expect(readUpdateResult(f.state, uid, AFTER)).toBeNull()
  })
})
