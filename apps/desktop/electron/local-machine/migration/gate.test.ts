import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalDaemonAccess } from '../mode'
import { fakeService } from './__fixtures__/fake-service'
import { runnerPorts } from './__fixtures__/runner-ports'
import { createLaunchGate, type GatePorts } from './gate'
import {
  MIGRATION_DIR,
  JOURNAL_FILE,
  journalWriter,
  migrationPermit,
  newJournal,
  readJournal,
  withState,
  type MigrationJournal,
} from './journal'
import { LOCAL_SERVICE_FEATURES } from '@phosphor/session-runtime/host-install/release-source'

const PERMIT = { allowed: true, brand: 'migration-permit' } as const
const ACCESS: LocalDaemonAccess = {
  location: { kind: 'dev', socket: '/nonexistent/s.sock', configDir: '/nonexistent/c' },
  ownerKey: () => Promise.reject(new Error('no key in tests')),
}
const UNREACHABLE: LocalDaemonAccess = { ...ACCESS, location: { ...ACCESS.location } }

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'm3-gate-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function gateWorld(over: Partial<GatePorts> = {}) {
  const service = fakeService()
  const runner = runnerPorts(root)
  const decide = vi.fn()
  const openChannel = vi.fn(async () => service.channel)
  const ports: GatePorts = {
    migrationDir: join(root, MIGRATION_DIR),
    permit: PERMIT,
    packaged: true,
    readLock: async () => 'free',
    legacyKeys: () => true,
    localRuntime: () => false,
    recordedFeatures: () => [...LOCAL_SERVICE_FEATURES],
    access: ACCESS,
    unreachable: UNREACHABLE,
    e2eDaemon: false,
    openChannel,
    runner: runner.ports,
    decide,
    ...over,
  }
  const journal = () => {
    const read = readJournal(ports.migrationDir)
    return read.kind === 'ok' ? read.journal : null
  }
  const seed = (j: MigrationJournal) => journalWriter(ports.migrationDir, PERMIT).write(j)
  return { service, runner, decide, openChannel, ports, journal, seed }
}

const AT = '2026-11-23T09:00:00.000Z'
const PREVIOUS = '00000000-0000-4000-8000-0000000000ff'
const journalIn = (state: MigrationJournal['state']) =>
  withState(newJournal({ migrationId: PREVIOUS, desktopVersion: '2.0.0', at: AT }), state, AT)

describe('launch gate', () => {
  it('an unpackaged run without both PHOSPHOR_MIGRATE=1 and PHOSPHOR_TEST_USER_DATA never writes a journal', async () => {
    for (const env of [{}, { PHOSPHOR_MIGRATE: '1' }, { PHOSPHOR_TEST_USER_DATA: root }]) {
      const w = gateWorld({ permit: migrationPermit({ isPackaged: false, env }), packaged: false })
      expect(await createLaunchGate(w.ports).run()).toBe('in-app')
      expect(existsSync(join(root, MIGRATION_DIR, JOURNAL_FILE))).toBe(false)
      expect(w.openChannel).not.toHaveBeenCalled()
    }
  })

  it('a default real launch (nothing recorded) stays in-app without asking any service', async () => {
    const w = gateWorld({ recordedFeatures: () => null })
    expect(await createLaunchGate(w.ports).run()).toBe('in-app')
    expect(w.decide).toHaveBeenCalledWith('in-app', ACCESS)
    expect(w.openChannel).not.toHaveBeenCalled()
  })

  it('migrates, decides daemon mode once, and reports committed', async () => {
    const w = gateWorld()
    const gate = createLaunchGate(w.ports)
    const seen: string[] = []
    gate.onStatus((s) => seen.push(s.step ?? s.migration))
    expect(await gate.run()).toBe('daemon')
    expect(w.decide).toHaveBeenCalledTimes(1)
    expect(w.decide).toHaveBeenCalledWith('daemon', ACCESS)
    expect(gate.status()).toEqual({ mode: 'daemon', migration: 'committed' })
    expect(seen).toEqual(expect.arrayContaining(['backup', 'lanes', 'verify', 'commit']))
    expect(w.journal()!.state).toBe('committed')
  })

  it('a service without both features, or not in standby, never triggers a migration', async () => {
    const w = gateWorld()
    const noFeatures = fakeService({ features: ['local-mode'] })
    expect(
      await createLaunchGate({ ...w.ports, openChannel: async () => noFeatures.channel }).run(),
    ).toBe('in-app')
    const owning = fakeService({ standby: false })
    expect(
      await createLaunchGate({ ...w.ports, openChannel: async () => owning.channel }).run(),
    ).toBe('in-app')
    expect(noFeatures.calls).not.toContain('owner.migrate.begin')
    expect(owning.calls).not.toContain('owner.migrate.begin')
  })

  it('times out with no journal: in-app, waiting', async () => {
    const w = gateWorld({ openChannel: async () => null })
    const gate = createLaunchGate(w.ports)
    expect(await gate.run()).toBe('in-app')
    expect(gate.status()).toEqual({ mode: 'in-app', migration: 'waiting' })
    expect(w.journal()).toBeNull()
  })

  it('a crash between commit-requested and commit never starts the in-app runtime', async () => {
    const w = gateWorld({ openChannel: async () => null })
    w.seed(journalIn('commit-requested'))
    const gate = createLaunchGate(w.ports)
    expect(await gate.run()).toBe('daemon')
    expect(w.decide).toHaveBeenCalledWith('daemon', ACCESS)
    expect(w.decide).not.toHaveBeenCalledWith('in-app', expect.anything())
    expect(gate.status()).toMatchObject({ mode: 'daemon', service: 'down' })
    // Once the service answers, the next launch finishes the commit.
    const v = gateWorld()
    v.service.states.set(PREVIOUS, 'staged')
    expect(await createLaunchGate(v.ports).run()).toBe('daemon')
    expect(v.service.states.get(PREVIOUS)).toBe('committed')
    expect(v.journal()!.state).toBe('committed')
  })

  it('an unforeseen failure while deciding never starts in-app once a commit was asked for', async () => {
    const failing = { readLock: () => Promise.reject(new Error('EIO')) }
    const w = gateWorld(failing)
    w.seed(journalIn('commit-requested'))
    expect(await createLaunchGate(w.ports).run()).toBe('daemon')
    expect(w.decide).not.toHaveBeenCalledWith('in-app', expect.anything())
    const fresh = gateWorld({ ...failing, migrationDir: join(root, 'fresh', MIGRATION_DIR) })
    expect(await createLaunchGate(fresh.ports).run()).toBe('in-app')
    expect(fresh.decide).toHaveBeenCalledWith('in-app', expect.anything())
  })

  it('commit-requested in a dev build without the flags shows the service’s data, writes nothing', async () => {
    const w = gateWorld()
    w.seed(journalIn('commit-requested'))
    const ports = {
      ...w.ports,
      permit: migrationPermit({ isPackaged: false, env: {} }),
      packaged: false,
      access: null,
    }
    const before = w.journal()
    expect(await createLaunchGate(ports).run()).toBe('daemon')
    expect(w.decide).toHaveBeenCalledWith('daemon', UNREACHABLE)
    expect(w.journal()).toEqual(before)
  })

  it('an interrupted attempt is aborted on the service and counted before the next one', async () => {
    const w = gateWorld()
    w.seed(journalIn('running'))
    w.service.states.set(PREVIOUS, 'staged')
    expect(await createLaunchGate(w.ports).run()).toBe('daemon')
    expect(w.service.states.get(PREVIOUS)).toBe('aborted')
    expect(w.journal()!.attempts['2.0.0']).toBe(1)
  })

  it('a failed attempt stays in-app with the failure', async () => {
    const w = gateWorld()
    const failing = runnerPorts(root, {
      verify: { ...w.runner.ports.verify, accounts: () => 3 },
    })
    const gate = createLaunchGate({ ...w.ports, runner: failing.ports })
    expect(await gate.run()).toBe('in-app')
    expect(gate.status()).toEqual({
      mode: 'in-app',
      migration: 'failed',
      failure: { step: 'verify', code: 'gate-g7' },
    })
  })

  it('N12: consent-needed in-app; consent journals it and surfaces the service’s refusal', async () => {
    const w = gateWorld({ readLock: async () => 'daemon', recordedFeatures: () => null })
    const gate = createLaunchGate(w.ports)
    expect(await gate.run()).toBe('in-app')
    expect(gate.status()).toEqual({
      mode: 'in-app',
      migration: 'consent-needed',
      notice: 'other-daemon',
    })
    const result = await gate.consent()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/machine.owner/)
    expect(w.journal()).toMatchObject({ state: 'consented', merge: true })
  })

  it('Retry journals the request after a failure; it is refused without a failed move', async () => {
    const w = gateWorld()
    const gate = createLaunchGate(w.ports)
    expect((await gate.retry()).ok).toBe(false)
    w.seed(journalIn('aborted'))
    expect(await gate.retry()).toMatchObject({ ok: true })
    expect(w.journal()!.retryRequested).toBe(true)
  })

  it('a quit before the commit point aborts the attempt and stays in-app', async () => {
    const w = gateWorld()
    const gate = createLaunchGate({
      ...w.ports,
      runner: {
        ...w.runner.ports,
        scan: (input) =>
          new Promise((r) => setTimeout(() => void w.runner.ports.scan(input).then(r), 50)),
      },
    })
    const mode = gate.run()
    await new Promise((r) => setTimeout(r, 5))
    await gate.quit()
    expect(await mode).toBe('in-app')
    expect(w.journal()).toMatchObject({ state: 'aborted', failure: { code: 'quit' } })
    expect(w.service.committed()).toBe(0)
  })
})
