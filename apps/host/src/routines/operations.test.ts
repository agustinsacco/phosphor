import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoutineRepository } from '@phosphor/session-runtime/routines/repository'
import { RoutineScheduler } from '@phosphor/session-runtime/routines/scheduler'
import { newRoutine, validateRoutine } from '@phosphor/shared/routines'
import type { RoutineOp } from '@phosphor/shared/host-protocol-routines'
import { createHostRuntime } from '../session/runtime'
import { createHostLog } from '../machine/log'
import { EXTENSIONS_ROOT } from '../__fixtures__/machine'
import type { HostRoutineState } from './service-state'
import { admittedRoutineRoot, executeRoutineOperation } from './operations'

const control = ['routines', 'sessions.control'] as const
const repositoryId = '0123456789abcdef'
const now = 1700000000000
let directory: string
let root: string
let state: HostRoutineState
let events: string[]
beforeEach(() => {
  directory = mkdtempSync(join(realpathSync(tmpdir()), 'routine-operations-'))
  root = join(directory, 'repo')
  mkdirSync(root)
  events = []
  const repository = new RoutineRepository(':memory:')
  const changed = vi.fn(() => {
    events.push('changed')
  })
  const runtime = createHostRuntime({
    pi: { binaryPath: process.execPath, prefixArgs: [] },
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory },
    roots: [root],
    resourceRoot: EXTENSIONS_ROOT,
    contextBudget: '',
    log: createHostLog(join(directory, 'logs'), []),
  })
  const scheduler = new RoutineScheduler(
    repository,
    async () => ({ status: 'finished', reason: 'Done.' }),
    changed,
    () => now,
  )
  state = {
    repository,
    scheduler,
    closing: false,
    closed: false,
    stopped: undefined,
    now: () => now,
    options: {
      directory,
      uid: process.getuid?.(),
      runtime,
      changed,
      store: { listRepositories: () => [{ id: repositoryId, path: root, name: 'Repo' }] },
    },
  }
  vi.spyOn(scheduler, 'tick').mockImplementation(() => {
    events.push('tick')
  })
})
afterEach(async () => {
  await state.scheduler.stop()
  state.repository.close()
  await state.options.runtime.drain('test end')
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
function input() {
  const { workspacePath: _path, ...config } = newRoutine(root)
  return {
    ...config,
    name: 'Report',
    instructions: 'Report.',
    provider: 'fake',
    model: 'fake-model',
    schedule: { kind: 'manual' as const },
    repositoryId,
    enabled: true,
    trusted: true,
  }
}
function seed() {
  return state.repository.save(validateRoutine({ ...input(), workspacePath: root }), now)
}
function run(routineId: string, workspacePath: string | null = root, promoted = false) {
  const repository = state.repository
  const created = repository.manual(routineId, randomUUID(), now)
  repository.patchRun(created.id, {
    sessionPath: join(directory, `${created.id}.jsonl`),
    workspacePath,
    promoted,
  })
  repository.finish(created.id, 'finished', 'Done.', now)
  return repository.run(created.id)
}
function execute(op: RoutineOp) {
  return executeRoutineOperation(state, op, 'request-id', control)
}

describe('routine operations', () => {
  it('saves before changed then tick, maps repository ids and acknowledges only updates', async () => {
    const save = state.repository.save.bind(state.repository)
    vi.spyOn(state.repository, 'save').mockImplementation((...args) => {
      events.push('save')
      return save(...args)
    })
    const created = await execute({
      type: 'routine.save',
      routine: input(),
      expectedRevision: null,
    })
    expect(events).toEqual(['save', 'changed', 'tick'])
    expect(created).toMatchObject({ routineId: expect.any(String), revision: 1 })
    const routine = state.repository.routines()[0]!
    expect(routine).toMatchObject({ workspacePath: root, enabled: false, trusted: false })
    expect(routine).not.toHaveProperty('repositoryId')
    events.length = 0
    expect(
      await execute({
        type: 'routine.save',
        routine: input(),
        routineId: routine.id,
        expectedRevision: 1,
      }),
    ).toEqual({ routineId: routine.id, revision: 2 })
    expect(state.repository.get(routine.id)).toMatchObject({ enabled: true, trusted: true })
    expect(events).toEqual(['save', 'changed', 'tick'])
    events.length = 0
    await expect(
      execute({
        type: 'routine.save',
        routine: input(),
        routineId: routine.id,
        expectedRevision: 1,
      }),
    ).rejects.toThrow('changed')
    expect(events).toEqual(['save'])
  })

  it('rejects missing, noncanonical repositories and the total routine bound without notifying', async () => {
    const op = { type: 'routine.save', routine: input(), expectedRevision: null } as const
    await expect(
      execute({ ...op, routine: { ...input(), repositoryId: 'fedcba9876543210' } }),
    ).rejects.toThrow('repository unavailable')
    const alias = join(directory, 'alias')
    symlinkSync(root, alias)
    state.options.store.listRepositories = () => [{ id: repositoryId, path: alias, name: 'Alias' }]
    await expect(execute(op)).rejects.toThrow('repository unavailable')
    state.options.store.listRepositories = () => [{ id: repositoryId, path: root, name: 'Repo' }]
    const routine = seed()
    vi.spyOn(state.repository, 'routines').mockReturnValue(
      Array.from({ length: 100 }, () => routine),
    )
    await expect(execute(op)).rejects.toThrow('routine limit')
    expect(events).toEqual([])
  })

  it('passes the request id to runNow and returns its run id without extra notifications', async () => {
    const routine = seed()
    const recorded = run(routine.id)
    const start = vi.spyOn(state.scheduler, 'runNow').mockReturnValue(recorded)
    expect(await execute({ type: 'routine.run', routineId: routine.id })).toEqual({
      runId: recorded.id,
    })
    expect(start).toHaveBeenCalledExactlyOnceWith(routine.id, 'request-id')
    expect(events).toEqual([])
  })

  it('checks cancel existence before waiting and adds no changed/tick of its own', async () => {
    const routine = seed()
    const recorded = run(routine.id)
    let release: () => void = () => {}
    const cancel = vi.spyOn(state.scheduler, 'cancelAndWait').mockImplementation(async () => {
      events.push('cancel')
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    await expect(execute({ type: 'routine.cancel', runId: randomUUID() })).rejects.toThrow(
      'Run not found.',
    )
    expect(cancel).not.toHaveBeenCalled()
    const pending = execute({ type: 'routine.cancel', runId: recorded.id })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    expect(await pending).toEqual({})
    expect(cancel).toHaveBeenCalledExactlyOnceWith(recorded.id)
    expect(events).toEqual(['cancel'])
  })

  it('skips the next occurrence, archives and pauses all with the original changed ordering', async () => {
    const routine = state.repository.save(
      validateRoutine({
        ...input(),
        workspacePath: root,
        schedule: { kind: 'once', at: now + 60000 },
      }),
      now,
    )
    const skip = vi.spyOn(state.repository, 'skipNext')
    expect(await execute({ type: 'routine.skipNext', routineId: routine.id })).toEqual({})
    expect(skip).toHaveBeenCalledExactlyOnceWith(routine.id, now)
    expect(state.repository.history(routine.id)[0]?.status).toBe('skipped')
    expect(events).toEqual(['changed'])
    events.length = 0
    expect(await execute({ type: 'routine.pauseAll' })).toEqual({})
    expect(state.repository.get(routine.id).enabled).toBe(false)
    expect(events).toEqual(['changed', 'changed'])
    events.length = 0
    expect(await execute({ type: 'routine.archive', routineId: routine.id })).toEqual({})
    expect(state.repository.get(routine.id).archived).toBe(true)
    expect(events).toEqual(['changed'])
  })

  it.each(['root', 'nested', 'alias', 'fallback'] as const)(
    'removes transcripts from a canonical contained %s cwd',
    async (kind) => {
      const nested = join(root, 'nested')
      mkdirSync(nested)
      const alias = join(directory, 'alias')
      symlinkSync(nested, alias)
      const cwd =
        kind === 'root' ? root : kind === 'fallback' ? null : kind === 'alias' ? alias : nested
      const routine = seed()
      const recorded = run(routine.id, cwd)
      run(routine.id, root, true)
      const remove = vi.spyOn(state.options.runtime, 'remove').mockImplementation(async () => {
        expect(state.repository.get(routine.id).archived).toBe(true)
        events.push('remove')
      })
      expect(await execute({ type: 'routine.delete', routineId: routine.id })).toEqual({})
      expect(remove).toHaveBeenCalledExactlyOnceWith({
        repository: kind === 'nested' || kind === 'alias' ? nested : root,
        sessionPath: recorded.sessionPath,
      })
      expect(events).toEqual(['changed', 'remove', 'changed'])
      expect(() => state.repository.get(routine.id)).toThrow('Routine not found.')
    },
  )

  it.each(['sibling', 'escape', 'unconfigured'] as const)(
    'refuses %s deletion cwd/source and retains the archived history',
    async (kind) => {
      const sibling = root + '-other'
      mkdirSync(sibling)
      const escape = join(root, 'escape')
      symlinkSync(sibling, escape)
      const routine = seed()
      run(routine.id, kind === 'escape' ? escape : kind === 'sibling' ? sibling : root)
      if (kind === 'unconfigured') state.options.store.listRepositories = () => []
      const remove = vi.spyOn(state.options.runtime, 'remove').mockResolvedValue()
      await expect(execute({ type: 'routine.delete', routineId: routine.id })).rejects.toThrow(
        'repository unavailable',
      )
      expect(remove).not.toHaveBeenCalled()
      expect(state.repository.get(routine.id).archived).toBe(true)
      expect(state.repository.history(routine.id)).toHaveLength(1)
      expect(events).toEqual(['changed'])
    },
  )

  it('rechecks closing between removals and before final deletion', async () => {
    const routine = seed()
    run(routine.id)
    run(routine.id)
    const remove = vi.spyOn(state.options.runtime, 'remove').mockImplementation(async () => {
      state.closing = true
    })
    await expect(execute({ type: 'routine.delete', routineId: routine.id })).rejects.toThrow(
      'stopping',
    )
    expect(remove).toHaveBeenCalledTimes(1)
    expect(state.repository.history(routine.id)).toHaveLength(2)
    expect(state.repository.get(routine.id).archived).toBe(true)
    expect(events).toEqual(['changed'])
    state.closing = false
    const other = seed()
    run(other.id)
    await expect(execute({ type: 'routine.delete', routineId: other.id })).rejects.toThrow(
      'stopping',
    )
    expect(state.repository.history(other.id)).toHaveLength(1)
  })

  it('checks closing immediately after archive notification even with no transcripts', async () => {
    const routine = seed()
    state.options.changed = () => {
      state.closing = true
    }
    await expect(execute({ type: 'routine.delete', routineId: routine.id })).rejects.toThrow(
      'stopping',
    )
    expect(state.repository.get(routine.id).archived).toBe(true)
  })

  it('rejects malformed operations and closing before capability or persistence checks', async () => {
    const routine = seed()
    const save = vi.spyOn(state.repository, 'save')
    await expect(execute({ type: 'routine.run', routineId: 'bad-id' })).rejects.toThrow(
      'invalid routine operation',
    )
    state.closing = true
    await expect(
      executeRoutineOperation(
        state,
        { type: 'routine.save', routine: input(), routineId: routine.id, expectedRevision: 1 },
        'request',
        [],
      ),
    ).rejects.toThrow('invalid routine operation')
    expect(save).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('admits only a currently configured canonical root', () => {
    expect(admittedRoutineRoot(state.options, root)).toBe(root)
    expect(() => admittedRoutineRoot(state.options, directory)).toThrow('repository unavailable')
  })
})
