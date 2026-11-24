import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MACHINE_ID, planFacts } from './__fixtures__/plan-facts'
import { fakeService } from './__fixtures__/fake-service'
import { rollForward } from './commit'
import {
  MIGRATION_DIR,
  MIGRATION_STEPS,
  journalWriter,
  pastCommitPoint,
  readJournal,
  stepDone,
  type JournalWriter,
  type MigrationJournal,
  type MigrationStep,
} from './journal'
import type { PostCommitSteps } from './post-commit'
import { buildPlan } from './plan'
import { runMigration, type RunnerPorts } from './runner'

const PERMIT = { allowed: true, brand: 'migration-permit' } as const
let root: string
let ids: number
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'm3-runner-'))
  ids = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

class Crash extends Error {}

function world(over: Partial<RunnerPorts> = {}) {
  const service = fakeService()
  const migrationDir = join(root, MIGRATION_DIR)
  const real = journalWriter(migrationDir, PERMIT)
  const alive = { value: true }
  const writer: JournalWriter = {
    dir: migrationDir,
    write(journal) {
      if (!alive.value) throw new Crash('dead process')
      real.write(journal)
    },
  }
  const localRuntime = vi.fn()
  const log = vi.fn()
  const device = vi.fn(async () => {})
  const postCommit: PostCommitSteps = { device }
  const ports: RunnerPorts = {
    userData: root,
    migrationDir,
    writer,
    owner: service.channel,
    now: () => Date.parse('2026-11-23T10:00:00.000Z'),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    desktopVersion: '2.0.0',
    routinesFile: 'routines.sqlite',
    scan: async ({ migrationId, machineId }) => ({
      ...planFacts({ migrationId, machineId }),
      routines: null,
    }),
    archives: async () => planFacts().archives.map((a) => a.record),
    verify: {
      readTranscript: async () => [],
      identity: (path) => ({ real: path, dev: 1, ino: 1, size: 1, isFile: true }),
      hash: async () => 'h',
      exists: (path) => !path.endsWith('routines.sqlite'),
      accounts: () => 0,
    },
    desktop: { agentDir: '/fixture/.pi/agent', sessionsRoot: '/fixture/.pi/agent/sessions' },
    postCommit,
    writeLocalRuntime: localRuntime,
    log,
    quit: new AbortController().signal,
    ...over,
  }
  const journal = () => {
    const read = readJournal(migrationDir)
    return read.kind === 'ok' ? read.journal : null
  }
  return { service, ports, alive, localRuntime, log, device, journal }
}

/** What the launch gate does with a journal on the next launch (the in-memory service survived). */
async function relaunch(w: ReturnType<typeof world>, ports: RunnerPorts) {
  w.alive.value = true
  w.service.revive()
  const previous = w.journal()
  if (previous && pastCommitPoint(previous.state)) return rollForward(ports, ports.owner, previous)
  return runMigration(ports, { previous, machineId: MACHINE_ID })
}

describe('runMigration', () => {
  it('stages, verifies and commits, then runs the post-commit steps and writes the marker', async () => {
    const w = world()
    const outcome = await runMigration(w.ports, { previous: null, machineId: MACHINE_ID })
    expect(outcome.kind).toBe('committed')
    const journal = w.journal()!
    expect(journal.state).toBe('committed')
    expect(journal.machineId).toBe(MACHINE_ID)
    for (const step of ['backup', 'plan', 'begin', 'lanes', 'verify', 'commit', 'device', 'done'])
      expect(stepDone(journal, step as MigrationStep), step).toBe(true)
    // M4's quarantine has no entry yet: pending, logged once, and daemon mode still follows.
    expect(stepDone(journal, 'quarantine')).toBe(false)
    expect(w.log.mock.calls.filter(([e]) => e === 'migration.step-pending')).toHaveLength(1)
    expect(w.device).toHaveBeenCalledTimes(1)
    expect(w.localRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'daemon', machineId: MACHINE_ID }),
    )
    expect(w.service.committed()).toBe(1)
  })

  it('a re-migration after a restore keeps the lane ids the service already has', async () => {
    const w = world()
    const lane = buildPlan(planFacts()).sections.lanes!.items[0]!
    const kept = '00000000-0000-4000-8000-00000000c0de'
    w.service.keep([
      {
        laneId: kept,
        sessionFile: lane.sessionFile,
        sessionId: null,
        cwd: lane.cwd,
        repositoryId: 'r',
      },
    ])
    const outcome = await runMigration(w.ports, { previous: null, machineId: MACHINE_ID })
    expect(outcome.kind).toBe('committed')
    expect(w.service.committed()).toBe(1)
  })

  it('aborts on a failed gate: the service undoes its staging and the attempt counts', async () => {
    const w = world()
    const outcome = await runMigration(
      { ...w.ports, verify: { ...w.ports.verify, accounts: () => 5 } },
      { previous: null, machineId: MACHINE_ID },
    )
    expect(outcome).toMatchObject({ kind: 'aborted', code: 'gate-g7' })
    expect(w.journal()).toMatchObject({
      state: 'aborted',
      failure: { step: 'verify', code: 'gate-g7' },
      attempts: { '2.0.0': 1 },
    })
    expect(w.service.calls).toContain('owner.migrate.abort')
    expect(w.service.calls).not.toContain('owner.migrate.commit')
    expect(w.localRuntime).not.toHaveBeenCalled()
  })

  it('an unexpected error aborts as internal and logs what it was, not only the code', async () => {
    const w = world()
    const scan = () => Promise.reject(new TypeError('cannot read the archive list'))
    const outcome = await runMigration(
      { ...w.ports, scan },
      { previous: null, machineId: MACHINE_ID },
    )
    expect(outcome).toMatchObject({ kind: 'aborted', code: 'internal' })
    expect(w.journal()).toMatchObject({ failure: { step: 'plan', code: 'internal' } })
    expect(w.log).toHaveBeenCalledWith('migration.aborted', {
      step: 'plan',
      code: 'internal',
      error: 'TypeError: cannot read the archive list',
    })
  })

  it('the 120 s budget aborts before the commit point', async () => {
    const w = world()
    const slow: RunnerPorts = {
      ...w.ports,
      budgetMs: 20,
      scan: (input) => new Promise((r) => setTimeout(() => void w.ports.scan(input).then(r), 200)),
    }
    const outcome = await runMigration(slow, { previous: null, machineId: MACHINE_ID })
    expect(outcome).toMatchObject({ kind: 'aborted', code: 'budget' })
    expect(w.journal()!.state).toBe('aborted')
    expect(w.service.calls).not.toContain('owner.migrate.commit')
  })

  it('a quit before the commit point aborts without counting an attempt', async () => {
    const w = world()
    const quit = new AbortController()
    const ports: RunnerPorts = {
      ...w.ports,
      quit: quit.signal,
      onStep: (step) => step === 'lanes' && quit.abort(),
    }
    const outcome = await runMigration(ports, { previous: null, machineId: MACHINE_ID })
    expect(outcome).toMatchObject({ kind: 'aborted', code: 'quit' })
    expect(w.journal()!.attempts['2.0.0']).toBeUndefined()
    expect(w.service.staged()).toBe(0)
  })

  it('a quit after commit-requested finishes the commit', async () => {
    const w = world()
    const quit = new AbortController()
    const ports: RunnerPorts = {
      ...w.ports,
      quit: quit.signal,
      onStep: (step) => step === 'commit' && quit.abort(),
    }
    expect((await runMigration(ports, { previous: null, machineId: MACHINE_ID })).kind).toBe(
      'committed',
    )
  })

  it('a refused begin (another attempt staged) aborts with the service code', async () => {
    const v = world()
    v.service.states.set('00000000-0000-4000-8000-00000000ffff', 'staged')
    const outcome = await runMigration(v.ports, { previous: null, machineId: MACHINE_ID })
    expect(outcome).toMatchObject({ kind: 'aborted', code: 'service-forbidden' })
  })
})

describe('crash convergence', () => {
  const sides = ['before', 'after'] as const
  const points = MIGRATION_STEPS.filter((s) => s !== 'quarantine').flatMap((step) =>
    sides.map((side) => [step, side] as const),
  )
  it.each(points)('a crash at %s (%s) converges to one committed migration', async (at, side) => {
    const w = world()
    let fired = false
    const crashing: RunnerPorts = {
      ...w.ports,
      crash: (step, when) => {
        if (fired || step !== at || when !== side) return
        fired = true
        w.alive.value = false
        w.service.kill()
        throw new Crash(`${step}:${when}`)
      },
    }
    await runMigration(crashing, { previous: null, machineId: MACHINE_ID }).catch((error) => {
      if (!(error instanceof Crash)) throw error
    })
    const crashed = w.journal()
    // The rule that protects users: past the commit point there is no way back to in-app.
    if (crashed && pastCommitPoint(crashed.state)) expect(w.service.states.size).toBeGreaterThan(0)
    let outcome = await relaunch(w, w.ports)
    // An aborted attempt (crash before the commit point) is retried on the launch after.
    if (outcome.kind === 'aborted') outcome = await relaunch(w, w.ports)
    expect(outcome.kind).toBe('committed')
    const final = w.journal() as MigrationJournal
    expect(final.state).toBe('committed')
    expect(stepDone(final, 'done')).toBe(true)
    expect(stepDone(final, 'device')).toBe(true)
    expect(w.service.committed()).toBe(1)
    expect(w.service.staged()).toBe(0)
  })

  it('commit-requested with a service that lost the attempt is stuck, never in-app', async () => {
    const w = world()
    await runMigration(
      {
        ...w.ports,
        crash: (step, side) => {
          if (step !== 'commit-request' || side !== 'after') return
          w.alive.value = false
          throw new Crash('x')
        },
      },
      { previous: null, machineId: MACHINE_ID },
    ).catch(() => {})
    w.alive.value = true
    w.service.states.clear()
    const journal = w.journal()!
    expect(journal.state).toBe('commit-requested')
    const outcome = await rollForward(w.ports, w.ports.owner, journal)
    expect(outcome.kind).toBe('stuck')
    expect(w.journal()).toMatchObject({
      state: 'commit-requested',
      failure: { code: 'commit-lost' },
    })
    expect((await rollForward(w.ports, null, journal)).kind).toBe('stuck')
  })
})
