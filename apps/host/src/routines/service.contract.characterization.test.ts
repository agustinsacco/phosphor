import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newRoutine, validateRoutine } from '@phosphor/shared/routines'
import type { RoutineOp } from '@phosphor/shared/host-protocol-routines'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { RoutineExecutor } from '@phosphor/session-runtime/routines/scheduler'
import { createHostRuntime } from '../session/runtime'
import { createHostLog } from '../machine/log'
import { EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { createHostRoutines } from './service'
import { createRoutineExecutor } from './runner'

vi.mock('./runner', () => ({ createRoutineExecutor: vi.fn() }))

const control = ['routines', 'sessions.control'] as const
const repositoryId = '0123456789abcdef'
let directory: string
let root: string
let service: ReturnType<typeof createHostRoutines>
let runtime: ReturnType<typeof createHostRuntime>
const now = 1700000000000

beforeEach(() => {
  directory = mkdtempSync(join(realpathSync(tmpdir()), 'routine-contract-'))
  root = join(directory, 'repo')
  mkdirSync(root)
  runtime = createHostRuntime({
    pi: { binaryPath: process.execPath, prefixArgs: [] },
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory },
    roots: [root],
    resourceRoot: EXTENSIONS_ROOT,
    contextBudget: '',
    log: createHostLog(join(directory, 'logs'), []),
  })
  runtime.life.to('validating')
  runtime.life.to('ready')
  vi.mocked(createRoutineExecutor).mockReturnValue(async () => ({
    status: 'finished',
    reason: 'Done.',
  }))
  service = createHostRoutines({
    directory: join(directory, 'state'),
    uid: process.getuid?.(),
    store: { listRepositories: () => [{ id: repositoryId, path: root, name: 'Repo' }] },
    runtime,
    changed: vi.fn(),
    now: () => now,
  })
})
afterEach(async () => {
  await service.close()
  await runtime.drain('test end')
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
function input(enabled = true, trusted = true) {
  const { workspacePath: _path, ...config } = newRoutine(root)
  return {
    ...config,
    name: 'Report',
    instructions: 'Report.',
    provider: 'fake',
    model: 'fake-model',
    schedule: { kind: 'manual' as const },
    repositoryId,
    enabled,
    trusted,
  }
}
function seed() {
  return service.scheduler.repository.save(
    validateRoutine({ ...input(false), workspacePath: root }),
    now,
  )
}
function finished(routineId: string, promoted = false) {
  const repository = service.scheduler.repository
  const run = repository.manual(routineId, randomUUID(), now)
  repository.patchRun(run.id, {
    sessionPath: join(directory, `${run.id}.jsonl`),
    workspacePath: root,
    promoted,
  })
  repository.finish(run.id, 'finished', 'Done.', now)
  return repository.run(run.id)
}

describe('Host routine public service contract', () => {
  it.each([
    [false, false],
    [false, true],
    [true, true],
  ])('creates paused/untrusted from enabled=%s trusted=%s', async (enabled, trusted) => {
    const saved = await service.execute(
      { type: 'routine.save', routine: input(enabled, trusted), expectedRevision: null },
      randomUUID(),
      control,
    )
    expect(saved).toMatchObject({ routineId: expect.any(String), revision: 1 })
    expect(service.scheduler.repository.routines()).toMatchObject([
      { enabled: false, trusted: false, revision: 1, workspacePath: root },
    ])
  })

  it('requires the current revision and preserves the definition on conflict', async () => {
    const routine = seed()
    const op: RoutineOp = {
      type: 'routine.save',
      routine: input(),
      routineId: routine.id,
      expectedRevision: routine.revision,
    }
    expect(await service.execute(op, randomUUID(), control)).toEqual({
      routineId: routine.id,
      revision: 2,
    })
    const saved = service.scheduler.repository.get(routine.id)
    await expect(service.execute(op, randomUUID(), control)).rejects.toThrow(
      'This routine changed. Reopen the editor before saving.',
    )
    expect(service.scheduler.repository.get(routine.id)).toEqual(saved)
  })

  it.each([
    ['save paused', false],
    ['save trusted', true],
    ['save enabled', true],
    ['run', true],
    ['cancel', false],
    ['skipNext', false],
    ['archive', false],
    ['delete', true],
    ['pauseAll', false],
  ] as const)('pins the exact capability matrix for %s', async (operation, needsControl) => {
    const routine = seed()
    const run = finished(routine.id)
    vi.spyOn(service.scheduler, 'tick').mockImplementation(() => {})
    vi.spyOn(service.scheduler, 'runNow').mockReturnValue(run)
    vi.spyOn(service.scheduler, 'cancelAndWait').mockResolvedValue()
    vi.spyOn(service.scheduler.repository, 'skipNext').mockImplementation(() => {})
    vi.spyOn(runtime, 'remove').mockResolvedValue()
    const op: RoutineOp = operation.startsWith('save')
      ? {
          type: 'routine.save',
          routine: input(operation === 'save enabled', operation !== 'save paused'),
          routineId: routine.id,
          expectedRevision: routine.revision,
        }
      : operation === 'cancel'
        ? { type: 'routine.cancel', runId: run.id }
        : operation === 'pauseAll'
          ? { type: 'routine.pauseAll' }
          : { type: `routine.${operation}` as 'routine.run', routineId: routine.id }
    for (const caps of [[], ['sessions.control']] as const)
      await expect(service.execute(op, randomUUID(), caps)).rejects.toThrow('forbidden')
    const caps: readonly HostCapability[] = needsControl ? control : ['routines']
    if (needsControl)
      await expect(service.execute(op, randomUUID(), ['routines'])).rejects.toThrow('forbidden')
    await expect(service.execute(op, randomUUID(), caps)).resolves.toBeDefined()
  })

  it('archives before removal, retains archive/history on failure and skips promoted transcripts', async () => {
    const routine = seed()
    const owned = finished(routine.id)
    finished(routine.id, true)
    const repository = service.scheduler.repository
    const remove = vi.spyOn(runtime, 'remove').mockImplementation(async (request) => {
      expect(repository.get(routine.id).archived).toBe(true)
      expect(repository.history(routine.id)).toHaveLength(2)
      expect(request).toEqual({ repository: root, sessionPath: owned.sessionPath })
      throw new Error('deletion failed')
    })
    const op: RoutineOp = { type: 'routine.delete', routineId: routine.id }
    await expect(service.execute(op, randomUUID(), control)).rejects.toThrow('deletion failed')
    expect(repository.get(routine.id).archived).toBe(true)
    expect(repository.history(routine.id)).toHaveLength(2)
    remove.mockResolvedValue()
    expect(await service.execute(op, randomUUID(), control)).toEqual({})
    expect(remove).toHaveBeenCalledTimes(2)
    expect(repository.history(routine.id)).toEqual([])
    expect(() => repository.get(routine.id)).toThrow('Routine not found.')
  })

  it('refuses running or over-1000-history deletion before archiving or removing', async () => {
    const routine = seed()
    const repository = service.scheduler.repository
    const run = repository.manual(routine.id, randomUUID(), now)
    repository.claim(run.id, now)
    const remove = vi.spyOn(runtime, 'remove').mockResolvedValue()
    const archive = vi.spyOn(repository, 'archive')
    const op: RoutineOp = { type: 'routine.delete', routineId: routine.id }
    await expect(service.execute(op, randomUUID(), control)).rejects.toThrow('running')
    repository.finish(run.id, 'finished', 'Done.', now)
    vi.spyOn(repository, 'history').mockReturnValue(Array.from({ length: 1001 }, () => run))
    await expect(service.execute(op, randomUUID(), control)).rejects.toThrow('history limit')
    expect(archive).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(repository.get(routine.id).archived).toBe(false)
  })

  it('stops idempotently and closes the database only after the worker stops', async () => {
    let release: () => void = () => {}
    let signal: AbortSignal | undefined
    const executor: RoutineExecutor = async (_run, current) => {
      signal = current
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { status: 'finished', reason: 'Done.' }
    }
    await service.close()
    vi.mocked(createRoutineExecutor).mockReturnValue(executor)
    service = createHostRoutines({
      directory: join(directory, 'state'),
      uid: process.getuid?.(),
      runtime,
      store: { listRepositories: () => [{ id: repositoryId, path: root, name: 'Repo' }] },
      changed: vi.fn(),
      now: () => now,
    })
    const routine = seed()
    await service.execute({ type: 'routine.run', routineId: routine.id }, randomUUID(), control)
    const close = vi.spyOn(service.scheduler.repository, 'close')
    const stop = vi.spyOn(service.scheduler, 'stop')
    const first = service.stop()
    expect(service.stop()).toBe(first)
    const closing = service.close()
    expect(signal?.aborted).toBe(true)
    expect(close).not.toHaveBeenCalled()
    expect(service.scheduler.repository.get(routine.id)).toBeDefined()
    release()
    await closing
    await service.close()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    await expect(
      service.execute({ type: 'routine.pauseAll' }, randomUUID(), control),
    ).rejects.toThrow('invalid routine operation')
    expect(await service.feature.call('routines.list', {})).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Routines stopping.' },
    })
  })
})
