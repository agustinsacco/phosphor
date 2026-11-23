vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: async () => [] }))
import { randomUUID } from 'node:crypto'
import { mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { atomicRecord } from '@phosphor/session-runtime/host-install/files'
import { fixture } from '../update/__fixtures__/release'
import { runUpdate } from './update'

const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

/** A Linux service install with the local-mode marker beside its config. */
function localDaemon() {
  const f = fixture()
  fixtures.push(f)
  f.release()
  const unit = join(f.home, '.config/systemd/user/phosphor-host.service')
  mkdirSync(join(unit, '..'), { recursive: true })
  writeFileSync(unit, 'unit')
  const config = join(f.context.configPath, '..')
  mkdirSync(config, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(config, 'local-mode.json'),
    JSON.stringify({ version: 1, enabledAt: '2026-11-23T00:00:00.000Z', shellEnvironment: false }),
    { mode: 0o600 },
  )
  const state = join(f.home, '.local/state/phosphor-host')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  let now = 10_000
  f.context.now = () => now
  f.context.wait = async () => {
    now += 1000
  }
  const localReady = (version: string) =>
    atomicRecord(
      join(state, 'local.json'),
      {
        version: 1,
        pid: process.pid,
        hostVersion: version,
        machineId: randomUUID(),
        socket: join(state, 'run/phosphor.sock'),
        startedAt: now,
        localReadyAt: now,
      },
      0o600,
    )
  return { f, state, localReady, at: () => now }
}

// R3: an unenrolled local daemon never heartbeats, so it never writes run.json.
it('passes the health check of an unenrolled local daemon on its local signal alone', async () => {
  const { f, localReady } = localDaemon()
  f.context.service = {
    runner: async (_program, args) => {
      if (args.includes('restart')) localReady('1.2.3')
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  expect(await runUpdate(f.context)).toBe(0)
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.2.3')
  expect(f.messages).toContain('Selected Host 1.2.3.')
})
