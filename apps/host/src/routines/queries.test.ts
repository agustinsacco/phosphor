import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoutineRepository } from '@phosphor/session-runtime/routines/repository'
import { RoutineScheduler } from '@phosphor/session-runtime/routines/scheduler'
import { newRoutine, validateRoutine } from '@phosphor/shared/routines'
import { createHostRuntime } from '../session/runtime'
import { createHostLog } from '../machine/log'
import { EXTENSIONS_ROOT } from '../__fixtures__/machine'
import type { HostRoutineState } from './service-state'
import { createRoutineQueries } from './queries'

const repositoryId = '0123456789abcdef'
const now = 1700000000000
let directory: string
let state: HostRoutineState
beforeEach(() => {
  directory = mkdtempSync(join(realpathSync(tmpdir()), 'routine-queries-'))
  const repository = new RoutineRepository(':memory:')
  const runtime = createHostRuntime({
    pi: { binaryPath: process.execPath, prefixArgs: [] },
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory },
    roots: [directory],
    resourceRoot: EXTENSIONS_ROOT,
    contextBudget: '',
    log: createHostLog(join(directory, 'logs'), []),
  })
  state = {
    repository,
    scheduler: new RoutineScheduler(repository, async () => ({
      status: 'finished',
      reason: 'Done.',
    })),
    closing: false,
    stopped: undefined,
    closed: false,
    now: () => now,
    options: {
      directory,
      uid: process.getuid?.(),
      runtime,
      changed: vi.fn(),
      store: { listRepositories: () => [{ id: repositoryId, path: directory, name: 'Repo' }] },
    },
  }
})
afterEach(async () => {
  await state.scheduler.stop()
  state.repository.close()
  await state.options.runtime.drain('test end')
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
function seed() {
  return state.repository.save(
    validateRoutine({
      ...newRoutine(directory),
      name: 'Report',
      instructions: 'Report.',
      provider: 'fake',
      model: 'fake-model',
      schedule: { kind: 'manual' },
      enabled: false,
      trusted: true,
    }),
    now,
  )
}

describe('routine queries', () => {
  it('declares exactly the routine capability and query methods', () => {
    expect(createRoutineQueries(state)).toMatchObject({
      capability: 'routines',
      methods: ['routines.list', 'routines.history'],
    })
  })

  it('projects the current repository id while excluding workspace path and attention', async () => {
    const routine = seed()
    const query = createRoutineQueries(state)
    const { workspacePath: _path, attention: _attention, ...remote } = routine
    expect(await query.call('routines.list', {})).toEqual({
      ok: true,
      data: [{ ...remote, repositoryId }],
    })
    state.options.store.listRepositories = () => [
      { id: 'fedcba9876543210', path: directory, name: 'Repo' },
    ]
    const result = await query.call('routines.list', {})
    expect(result).toEqual({ ok: true, data: [{ ...remote, repositoryId: 'fedcba9876543210' }] })
    expect(JSON.stringify(result)).not.toContain(directory)
    state.options.store.listRepositories = () => []
    expect(await query.call('routines.list', {})).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Routine query unavailable.' },
    })
  })

  it('pages fifty path-free history records in repository order and strips all diagnostic fields', async () => {
    const routine = seed()
    for (let i = 0; i < 55; i++) {
      const run = state.repository.manual(routine.id, randomUUID(), now + i)
      state.repository.patchRun(run.id, {
        workspacePath: directory,
        sessionPath: join(directory, 'private.jsonl'),
        summary: 'private output',
        branch: 'private-branch',
        sessionId: 'private-session',
      })
      state.repository.finish(run.id, 'finished', 'private diagnostic', now + i + 1)
    }
    const history = vi.spyOn(state.repository, 'history')
    const query = createRoutineQueries(state)
    const result = await query.call('routines.history', { routineId: routine.id, offset: 3 })
    expect(history).toHaveBeenCalledWith(routine.id, 3, 50)
    const expected = state.repository
      .history(routine.id, 3, 50)
      .map(({ id, routineId, status, scheduledAt, startedAt, endedAt }) => ({
        id,
        routineId,
        status,
        scheduledAt,
        startedAt,
        endedAt,
      }))
    expect(expected).toHaveLength(50)
    expect(result).toEqual({ ok: true, data: expected })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain(directory)
    expect(await query.call('routines.history', { routineId: routine.id, offset: 100000 })).toEqual(
      { ok: true, data: [] },
    )
    await query.call('routines.history', { routineId: routine.id })
    expect(history).toHaveBeenLastCalledWith(routine.id, 0, 50)
  })

  it.each([
    ['routines.list', { extra: true }],
    ['routines.history', {}],
    ['routines.history', { routineId: 'bad-id' }],
    ['routines.history', { routineId: '00000000-0000-4000-8000-000000000000', offset: -1 }],
    ['routines.history', { routineId: '00000000-0000-4000-8000-000000000000', offset: 100001 }],
    ['routines.history', { routineId: '00000000-0000-4000-8000-000000000000', offset: 0.5 }],
    ['routines.unknown', {}],
  ])('rejects invalid query %s %j before reading the repository', async (method, params) => {
    const list = vi.spyOn(state.repository, 'routines')
    const history = vi.spyOn(state.repository, 'history')
    expect(await createRoutineQueries(state).call(method, params)).toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'Invalid routine query.' },
    })
    expect(list).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
  })

  it('fails closed on missing history or database errors without exposing diagnostics', async () => {
    const query = createRoutineQueries(state)
    const history = vi.spyOn(state.repository, 'history')
    expect(await query.call('routines.history', { routineId: randomUUID() })).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Routine query unavailable.' },
    })
    expect(history).not.toHaveBeenCalled()
    vi.spyOn(state.repository, 'routines').mockImplementation(() => {
      throw new Error(directory)
    })
    expect(await query.call('routines.list', {})).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Routine query unavailable.' },
    })
  })

  it('checks closing before parsing queries or accessing the repository', async () => {
    state.closing = true
    const list = vi.spyOn(state.repository, 'routines')
    expect(await createRoutineQueries(state).call('invalid', null)).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Routines stopping.' },
    })
    expect(list).not.toHaveBeenCalled()
  })
})
