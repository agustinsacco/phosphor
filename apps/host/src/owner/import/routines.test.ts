import { routineHandlers } from '../../ops/handlers/routines'
import type { DaemonHandlerDeps } from '../../ops/handlers'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { newRoutine, type RoutineInput } from '@phosphor/shared/routines'
import { RoutineRepository } from '@phosphor/session-runtime/routines/repository'
import { loadRoutineSqlite } from '@phosphor/session-runtime/routines/sqlite'
import { prepareStateDirectory, prepareStateFile } from '../../lanes/state-dir'
import { OwnerCallRefused } from '../adapter'
import { scratchHost, snapshotFolder, uid, type ScratchHost } from './__fixtures__/scratch-host'
import { ROUTINE_REFUSALS, routineImporter } from './routines'

const now = Date.parse('2026-09-21T08:00Z')
let host: ScratchHost
let repo: string
let desktop: string
beforeEach(async () => {
  host = await scratchHost()
  repo = host.folder('repo')
  host.store.syncRepositories([repo])
  desktop = join(host.root, 'backup', 'routines.sqlite')
})
afterEach(() => host.close())

const input = (patch: Partial<RoutineInput> = {}): RoutineInput => ({
  ...newRoutine(repo),
  name: 'Morning report',
  instructions: 'Write a report.',
  model: 'test',
  provider: 'test',
  timezone: 'UTC',
  enabled: true,
  trusted: true,
  schedule: { kind: 'cron', expression: '0 9 * * *' },
  ...patch,
})

/** Desktop's routines: one trusted and scheduled with a past run, and its background switch. */
function desktopRoutines(patch: Partial<RoutineInput> = {}) {
  mkdirSync(join(host.root, 'backup'), { recursive: true })
  const repository = new RoutineRepository(desktop)
  try {
    const routine = repository.save(input(patch), now)
    repository.manual(routine.id, 'click', now + 1)
    repository.setBackground(true)
    return { routines: repository.routines(), runs: repository.history() }
  } finally {
    repository.close()
  }
}

/** The daemon's routines database, made as the Host makes it. */
function daemonDatabase(): string {
  const dir = join(host.state, 'routines')
  prepareStateDirectory(dir, uid)
  return prepareStateFile(dir, uid)
}

function daemonRoutines() {
  const repository = new RoutineRepository(daemonDatabase())
  try {
    return {
      routines: repository.routines(),
      runs: repository.history(),
      background: repository.background(),
    }
  } finally {
    repository.close()
  }
}

const importRoutines = (workspaces = [repo]) =>
  routineImporter(host.ports).apply(
    { section: 'routines', database: desktop, workspaces },
    host.context(),
  )

it('imports row for row: trust, schedule and history kept, nothing fired', async () => {
  const before = desktopRoutines()
  await importRoutines()
  const after = daemonRoutines()
  expect(after.routines).toEqual(before.routines)
  expect(after.routines[0]).toMatchObject({ trusted: true, enabled: true })
  expect(after.routines[0]?.nextAt).toBe(before.routines[0]?.nextAt)
  expect(after.runs).toEqual(before.runs)
  expect(after.background).toBe(true)
  await importRoutines()
  expect(daemonRoutines().runs).toHaveLength(1)
})

it('refuses a routine whose folder was not imported, writing nothing', async () => {
  const other = host.folder('other')
  desktopRoutines({ workspacePath: other })
  await expect(importRoutines()).rejects.toEqual(
    new OwnerCallRefused('bad-request', ROUTINE_REFUSALS.folder),
  )
  await expect(importRoutines([other])).rejects.toEqual(
    new OwnerCallRefused('bad-request', ROUTINE_REFUSALS.folder),
  )
  expect(daemonRoutines().routines).toEqual([])
})

it('refuses a different routine under an id the daemon already has', async () => {
  const [routine] = desktopRoutines().routines
  new RoutineRepository(daemonDatabase()).close()
  const { DatabaseSync } = loadRoutineSqlite()
  const db = new DatabaseSync(daemonDatabase())
  db.prepare('INSERT INTO routines(id,data) VALUES (?,?)').run(
    routine!.id,
    JSON.stringify({ ...routine, name: 'Changed on the service' }),
  )
  db.close()
  await expect(importRoutines()).rejects.toEqual(
    new OwnerCallRefused('forbidden', ROUTINE_REFUSALS.taken),
  )
  expect(daemonRoutines().runs).toEqual([])
})

it('abort removes exactly the rows the import added', async () => {
  const own = new RoutineRepository(daemonDatabase())
  const kept = own.save(input({ name: 'The service’s own' }), now)
  own.close()
  const importer = routineImporter(host.ports)
  const folder = snapshotFolder(host, 'routines')
  await importer.snapshot!(folder)
  desktopRoutines()
  await importRoutines()
  expect(daemonRoutines().routines).toHaveLength(2)
  await importer.restore!(folder)
  expect(daemonRoutines()).toEqual({ routines: [kept], runs: [], background: false })
})

// PR #752 already copied these exact run rows, without admitting a lane.
it.each(['fresh import', 'already committed'])(
  'opens saved output after %s without a sidebar lane',
  async (mode) => {
    const file = host.session('repo')
    const message = { role: 'assistant', content: [{ type: 'text', text: 'Saved conversation.' }] }
    appendFileSync(file, `${JSON.stringify({ type: 'message', message })}\n`)
    for (const display of [false, true]) {
      const entry = {
        type: 'custom_message',
        display,
        content: display ? 'Visible note.' : 'Hidden note.',
      }
      appendFileSync(file, `${JSON.stringify(entry)}\n`)
    }
    const db = mode === 'fresh import' ? desktop : daemonDatabase()
    mkdirSync(join(host.root, 'backup'), { recursive: true })
    const source = new RoutineRepository(db)
    const routine = source.save(input(), now)
    const run = source.manual(routine.id, 'click', now)
    source.patchRun(run.id, { status: 'finished', sessionPath: file })
    source.close()
    if (mode === 'fresh import') await importRoutines()
    const kept = new RoutineRepository(daemonDatabase())
    try {
      const handlers = routineHandlers({
        store: host.store,
        sessionsRoot: host.sessions,
        routines: { sessionPathForRun: (id: string) => kept.run(id).sessionPath },
        lanes: {
          calls: {
            capabilityFor: () => 'sessions.read',
            call: async () => ({ ok: true, data: [] }),
          },
        },
      } as unknown as DaemonHandlerDeps)
      const ctx = {
        principal: { kind: 'surface', caps: ['routines', 'sessions.read'] },
        signal: new AbortController().signal,
      } as never
      for (let i = 0; i < 2; i++) {
        const result = await handlers['routine.history']!({ runId: run.id }, ctx)
        expect(result.data).toMatchObject({
          content: expect.stringContaining('Saved conversation.'),
        })
        expect(result.data).toMatchObject({ content: expect.stringContaining('Visible note.') })
        expect(JSON.stringify(result)).not.toContain('Hidden note.')
        expect(JSON.stringify(result)).not.toContain(file)
      }
      expect(host.store.listLanes()).toEqual([])
    } finally {
      kept.close()
    }
  },
)
