import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newRoutine } from '@phosphor/shared/routines'
import { parseRoutineList } from '@phosphor/shared/host-protocol-routines'
import { parseHostFrame, type HostFrame, type Receipt } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { createLaneAdapter } from '../api/lanes'
import { createLaneStreams, createLanesTopic } from '../lanes/stream'
import { createHostRuntime, type HostRuntime } from '../session/runtime'
import { createHostLog } from '../machine/log'
import { openStore, type HostStore } from '../lanes/store'
import { createLaneCommands } from '../lanes/commands'
import { EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { createHostRoutines, routineOwnership, type HostRoutines } from './service'

let directory: string
let root: string
let runtime: HostRuntime
let store: HostStore
let routines: HostRoutines
let commands: ReturnType<typeof createLaneCommands>
let receipts: Receipt[]
let adapter: ReturnType<typeof createLaneAdapter> | undefined
let repositoryId: string
const clientId = randomUUID()
const control = ['routines', 'sessions.control'] as const
beforeEach(async () => {
  directory = mkdtempSync(join(realpathSync(tmpdir()), 'host-routines-'))
  root = join(directory, 'repo')
  mkdirSync(root)
  vi.stubEnv('PI_CODING_AGENT_DIR', join(directory, 'agent'))
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  vi.stubEnv('PATH', process.env.PATH)
  store = await openStore(join(directory, 'state'), process.getuid?.())
  const entry = store.syncRepositories([root])[0]
  if (!entry) throw new Error('missing repository')
  repositoryId = entry.id
  runtime = createHostRuntime(
    {
      pi: {
        binaryPath: process.execPath,
        prefixArgs: [join(import.meta.dirname, '../__fixtures__/fake-pi.cjs')],
      },
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: directory,
        PI_FAKE_MODEL: 'fake-model',
        PI_CODING_AGENT_DIR: join(directory, 'agent'),
      },
      roots: [root],
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
      log: createHostLog(join(directory, 'logs'), []),
    },
    {
      dialogs: 'forward',
      routines: routineOwnership((id) => routines.cancelSession(id)),
      timings: { abortMs: 100, graceMs: 100, deadlineMs: 2000, settleMs: 100 },
    },
  )
  runtime.life.to('validating')
  runtime.life.to('ready')
  routines = createHostRoutines({
    directory: join(directory, 'state'),
    uid: process.getuid?.(),
    runtime,
    store,
    changed: vi.fn(),
  })
  receipts = []
  adapter = undefined
  commands = createLaneCommands({
    store,
    runtime,
    routines,
    sessions: {
      start: async () => {
        throw new Error('not used')
      },
      attach: async () => {},
      stop: async () => {},
    },
    resumeLane: async () => {},
    stopLane: async () => {},
    sessionFor: () => null,
    openDialogs: () => [],
    summaryFor: () => null,
    publish: () => {},
    deliver: (id, receipt, connectionId) => {
      receipts.push(receipt)
      adapter?.deliver(id, receipt, connectionId)
    },
    now: Date.now,
    log: () => {},
  })
})
afterEach(async () => {
  await routines?.close()
  await commands?.close()
  await runtime?.drain('test end')
  store?.close()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})
function input(instructions = 'Report.') {
  const { workspacePath: _path, ...config } = newRoutine(root)
  return {
    ...config,
    name: 'Report',
    instructions,
    provider: 'fake',
    model: 'fake-model',
    isolated: false,
    schedule: { kind: 'manual' as const },
    repositoryId,
    enabled: true,
    trusted: true,
  }
}
async function list() {
  const result = await routines.feature.call('routines.list', {})
  if (!result.ok) throw new Error(result.error.message)
  const parsed = parseRoutineList(result.data)
  if (!parsed) throw new Error('invalid result')
  return parsed
}
async function saved(instructions?: string) {
  await routines.execute(
    { type: 'routine.save', routine: input(instructions), expectedRevision: null },
    randomUUID(),
    control,
  )
  const routine = (await list()).at(-1)
  if (!routine) throw new Error('missing routine')
  await routines.execute(
    {
      type: 'routine.save',
      routine: { ...input(instructions), enabled: false },
      routineId: routine.id,
      expectedRevision: routine.revision,
    },
    randomUUID(),
    control,
  )
  return routine.id
}
function observeRequests() {
  const original = runtime.routineClient
  const clients: ReturnType<HostRuntime['routineClient']>[] = []
  vi.spyOn(runtime, 'routineClient').mockImplementation((id) => {
    const client = original(id)
    vi.spyOn(client, 'request')
    clients.push(client)
    return client
  })
  return () =>
    clients.flatMap((client) => vi.mocked(client.request).mock.calls.map(([command]) => command))
}
async function waitFor(status: string, except: readonly string[] = []) {
  for (let i = 0; i < 200; i++) {
    const run = routines.scheduler
      .snapshot()
      .runs.find((run) => run.status === status && !except.includes(run.id))
    if (run) return run
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error(`no ${status} run`)
}
describe('Host routines daemon', () => {
  it('creates paused/untrusted and requires an explicit later controller acknowledgment', async () => {
    await routines.execute(
      { type: 'routine.save', routine: input(), expectedRevision: null },
      randomUUID(),
      control,
    )
    const routine = (await list())[0]
    expect(routine).toMatchObject({ enabled: false, trusted: false, repositoryId })
    expect(JSON.stringify(await list())).not.toContain(root)
    if (!routine) throw new Error('missing routine')
    await expect(
      routines.execute(
        {
          type: 'routine.save',
          routine: input(),
          routineId: routine.id,
          expectedRevision: routine.revision,
        },
        randomUUID(),
        ['routines'],
      ),
    ).rejects.toThrow('forbidden')
    await expect(
      routines.execute({ type: 'routine.run', routineId: routine.id }, randomUUID(), control),
    ).rejects.toThrow()
    await routines.execute(
      {
        type: 'routine.save',
        routine: { ...input(), enabled: false },
        routineId: routine.id,
        expectedRevision: routine.revision,
      },
      randomUUID(),
      control,
    )
    await expect(
      routines.execute(
        {
          type: 'routine.save',
          routine: input(),
          routineId: routine.id,
          expectedRevision: routine.revision,
        },
        randomUUID(),
        control,
      ),
    ).rejects.toThrow('changed')
  })
  it('uses receipts before effects, deduplicates and rejects capability loss at admission', async () => {
    expect(commands.capabilityFor({ type: 'routine.run', routineId: randomUUID() })).toEqual([
      'routines',
      'sessions.control',
    ])
    expect(commands.capabilityFor({ type: 'routine.pauseAll' })).toEqual(['routines'])
    const execute = vi.spyOn(routines, 'execute')
    const requestId = randomUUID()
    const frame = { type: 'command' as const, requestId, op: { type: 'routine.pauseAll' as const } }
    execute.mockImplementationOnce(async () => {
      expect(store.getReceipt(requestId, clientId)?.status).toBe('pending')
      return {}
    })
    await commands.submit({ id: clientId, label: 'Client', caps: ['routines'] }, frame)
    await commands.submit({ id: clientId, label: 'Client', caps: ['routines'] }, frame)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(receipts.at(-1)?.status).toBe('done')
    const routineId = await saved()
    for (const op of [
      { type: 'routine.run' as const, routineId },
      { type: 'routine.delete' as const, routineId },
      { type: 'routine.save' as const, routine: input(), routineId, expectedRevision: 2 },
    ]) {
      await commands.submit(
        { id: clientId, label: 'Client', caps: ['routines'] },
        { type: 'command', requestId: randomUUID(), op },
      )
      expect(receipts.at(-1)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    }
    await commands.submit(
      { id: clientId, label: 'Client', caps: control, currentCaps: () => ['routines'] },
      { type: 'command', requestId: randomUUID(), op: { type: 'routine.run', routineId } },
    )
    expect(receipts.at(-1)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    let release: (data: Awaited<ReturnType<HostRoutines['execute']>>) => void = () => {}
    execute.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done
        }),
    )
    const held = commands.submit(
      { id: clientId, label: 'Client', caps: ['routines'] },
      { type: 'command', requestId: randomUUID(), op: { type: 'routine.pauseAll' } },
    )
    let current: readonly ('routines' | 'sessions.control')[] = control
    const queued = commands.submit(
      { id: clientId, label: 'Client', caps: control, currentCaps: () => current },
      { type: 'command', requestId: randomUUID(), op: { type: 'routine.run', routineId } },
    )
    current = ['routines']
    release({})
    await Promise.all([held, queued])
    expect(receipts.at(-1)).toMatchObject({ status: 'rejected', code: 'forbidden' })
  })
  it.each(['close', 'renew'] as const)(
    'refuses a queued run after adapter %s without starting it and preserves owner receipts',
    async (loss) => {
      const routineId = await saved()
      const execute = vi.spyOn(routines, 'execute')
      let release: (data: Awaited<ReturnType<HostRoutines['execute']>>) => void = () => {}
      execute.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      const submit = vi.fn(commands.submit)
      const epoch = '0123456789abcdef'
      adapter = createLaneAdapter({
        epoch,
        capabilities: control,
        commands: { ...commands, submit },
        calls: { capabilityFor: () => null, call: async () => ({ ok: true, data: null }) },
        streams: createLaneStreams({ epoch, snapshot: () => null }),
        lanesTopic: createLanesTopic({ epoch, list: () => ({ lanes: [], repositories: [] }) }),
        controllerPresence: () => {},
      })
      const pair = createLoopbackPair()
      const frames: HostFrame[] = []
      pair.client.onMessage((text) => {
        const parsed = parseHostFrame(text)
        if (!parsed.ok) throw new Error('Invalid frame')
        frames.push(parsed.value)
      })
      const handler = adapter.handler({
        client: { id: clientId, label: 'Client' },
        caps: control,
        connectionId: epoch,
        socket: pair.server,
      })
      const heldId = randomUUID()
      const requestId = randomUUID()
      try {
        handler.handle(
          { type: 'command', requestId: heldId, op: { type: 'routine.pauseAll' } },
          control,
        )
        handler.handle(
          { type: 'command', requestId, op: { type: 'routine.run', routineId } },
          control,
        )
        expect(execute).toHaveBeenCalledTimes(1)
        expect(store.getReceipt(requestId, clientId)?.status).toBe('pending')
        if (loss === 'close') handler.close()
        else handler.renew(['routines'])
        release({})
        await Promise.all(submit.mock.results.map((result) => result.value))
        expect(execute).toHaveBeenCalledTimes(1)
        expect(store.getReceipt(requestId, clientId)).toMatchObject({
          status: 'rejected',
          code: 'forbidden',
        })
        expect(routines.scheduler.snapshot().runs).toEqual([])
        if (loss === 'renew') {
          expect(frames).toContainEqual({
            type: 'receipt',
            receipt: { requestId, status: 'rejected', code: 'forbidden' },
          })
          expect(frames).toContainEqual({
            type: 'receipt',
            receipt: { requestId: heldId, status: 'done', data: {} },
          })
          handler.handle({ type: 'receipt-status', requestId }, ['routines'])
          expect(frames.at(-1)).toMatchObject({
            type: 'receipt',
            receipt: { requestId, status: 'rejected', code: 'forbidden' },
          })
        }
      } finally {
        release({})
        handler.close()
        pair.client.close(1000, 'test end')
      }
    },
  )
  it('runs with no clients, records bounded history and rejects an unconfigured repository', async () => {
    const requests = observeRequests()
    const id = await saved()
    await routines.execute({ type: 'routine.run', routineId: id }, randomUUID(), control)
    await waitFor('finished')
    expect(requests()).toContainEqual({ type: 'set_auto_retry', enabled: false })
    expect(requests().filter((command) => command.type === 'prompt')).toHaveLength(1)
    const history = await routines.feature.call('routines.history', { routineId: id })
    expect(history.ok).toBe(true)
    expect(JSON.stringify(history)).not.toContain(root)
    expect(runtime.list()).toHaveLength(0)
    await expect(
      routines.execute(
        {
          type: 'routine.save',
          routine: { ...input(), repositoryId: '0123456789abcdef' },
          expectedRevision: null,
        },
        randomUUID(),
        control,
      ),
    ).rejects.toThrow('repository unavailable')
  })
  it('fails closed when the configured repository is removed before execution', async () => {
    const requests = observeRequests()
    const id = await saved()
    store.syncRepositories([])
    await routines.execute({ type: 'routine.run', routineId: id }, randomUUID(), control)
    await waitFor('blocked')
    expect(requests()).toHaveLength(0)
  })

  it('bounds deletion before touching data and deletes exactly at the history limit', async () => {
    const id = await saved()
    const repository = routines.scheduler.repository
    const addHistory = (routineId: string, count: number) => {
      const seed = repository.manual(routineId, randomUUID(), Date.now())
      repository.finish(seed.id, 'finished', 'Test complete.', Date.now())
      const template = repository.run(seed.id)
      const database = new DatabaseSync(join(directory, 'state', 'routines', 'state.sqlite'))
      try {
        database.exec('BEGIN IMMEDIATE')
        const insert = database.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?)')
        for (let i = 1; i < count; i++) {
          const runId = randomUUID()
          insert.run(
            runId,
            routineId,
            `${routineId}:fixture:${runId}`,
            Date.now(),
            JSON.stringify({ ...template, id: runId }),
          )
        }
        database.exec('COMMIT')
      } finally {
        database.close()
      }
    }
    addHistory(id, 1001)
    await expect(
      routines.execute({ type: 'routine.delete', routineId: id }, randomUUID(), control),
    ).rejects.toThrow('history limit')
    expect(repository.history(id, 0, 1001)).toHaveLength(1001)
    expect(repository.get(id).archived).toBe(false)
    const emptyId = await saved()
    addHistory(emptyId, 1000)
    await routines.execute({ type: 'routine.delete', routineId: emptyId }, randomUUID(), control)
    expect(repository.history(emptyId)).toHaveLength(0)
    expect(() => repository.get(emptyId)).toThrow('not found')
  })

  it('persists acknowledgment and catches up a schedule after restart with zero clients', async () => {
    const id = await saved()
    const revision = (await list()).find((r) => r.id === id)?.revision
    if (!revision) throw new Error('missing routine')
    await routines.execute(
      {
        type: 'routine.save',
        routineId: id,
        expectedRevision: revision,
        routine: { ...input(), schedule: { kind: 'once', at: Date.now() + 50 } },
      },
      randomUUID(),
      control,
    )
    await routines.close()
    await new Promise((done) => setTimeout(done, 60))
    routines = createHostRoutines({
      directory: join(directory, 'state'),
      uid: process.getuid?.(),
      runtime,
      store,
      changed: vi.fn(),
    })
    expect((await list())[0]?.trusted).toBe(true)
    routines.start()
    const run = await waitFor('finished')
    expect(run.trigger).toBe('schedule')
    expect(runtime.list()).toHaveLength(0)
  })

  it('blocks exact-model mismatch without prompting or retrying effects', async () => {
    const requests = observeRequests()
    const id = await saved()
    const routine = (await list()).find((r) => r.id === id)
    if (!routine) throw new Error('missing routine')
    await routines.execute(
      {
        type: 'routine.save',
        routineId: id,
        routine: { ...input(), model: 'unavailable', enabled: false },
        expectedRevision: routine.revision,
      },
      randomUUID(),
      control,
    )
    await routines.execute({ type: 'routine.run', routineId: id }, randomUUID(), control)
    await waitFor('blocked')
    expect(requests().filter((command) => command.type === 'prompt')).toHaveLength(0)
    expect(routines.scheduler.snapshot().runs[0]?.summary).toBe('')
  })
  it('refuses occupied source folders, dirty code tasks and failed isolation', async () => {
    const requests = observeRequests()
    const id = await saved()
    const interactive = await runtime.start({ repository: root })
    await routines.execute({ type: 'routine.run', routineId: id }, randomUUID(), control)
    const first = await waitFor('blocked')
    expect(requests()).toHaveLength(0)
    await runtime.stop(interactive.sessionId)
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' })
    writeFileSync(join(root, 'tracked.txt'), 'baseline')
    execFileSync('git', ['-C', root, 'add', 'tracked.txt'], { stdio: 'ignore' })
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'baseline',
      ],
      { stdio: 'ignore' },
    )
    writeFileSync(join(root, 'untracked.txt'), 'private test')
    let revision = (await list()).find((r) => r.id === id)?.revision
    if (!revision) throw new Error('missing routine')
    await routines.execute(
      {
        type: 'routine.save',
        routineId: id,
        expectedRevision: revision,
        routine: { ...input(), intent: 'code', enabled: false },
      },
      randomUUID(),
      control,
    )
    await routines.execute({ type: 'routine.run', routineId: id }, randomUUID(), control)
    const second = await waitFor('blocked', [first.id])
    rmSync(join(root, '.git'), { recursive: true, force: true })
    expect(requests()).toHaveLength(0)
    revision = (await list()).find((r) => r.id === id)?.revision
    if (!revision) throw new Error('missing routine')
    await routines.execute(
      {
        type: 'routine.save',
        routineId: id,
        expectedRevision: revision,
        routine: { ...input(), isolated: true, enabled: false },
      },
      randomUUID(),
      control,
    )
    await routines.execute({ type: 'routine.run', routineId: id }, randomUUID(), control)
    await waitFor('blocked', [first.id, second.id])
    expect(routines.scheduler.snapshot().runs.every((r) => r.status === 'blocked')).toBe(true)
    expect(requests()).toHaveLength(0)
    expect(runtime.list()).toHaveLength(0)
  })

  it('blocks unexpected extension dialogs without sending an answer', async () => {
    const original = runtime.startRoutine
    const answer = vi.spyOn(runtime, 'extensionUiResponse')
    vi.spyOn(runtime, 'startRoutine').mockImplementation(async (request, deliver, execution) => {
      const live = await original(request, deliver, execution)
      deliver({
        kind: 'extension-ui',
        request: {
          type: 'extension_ui_request',
          id: randomUUID(),
          method: 'confirm',
          title: 'Input required',
          message: 'Continue?',
        },
      })
      return live
    })
    const id = await saved()
    await routines.execute({ type: 'routine.run', routineId: id }, randomUUID(), control)
    await waitFor('blocked')
    expect(answer).not.toHaveBeenCalled()
  })

  it('protects a live routine from manual mutation, disposal and resume races', async () => {
    const id = await saved('stream')
    await routines.execute({ type: 'routine.run', routineId: id }, randomUUID(), control)
    const run = await waitFor('running')
    for (let i = 0; !run.sessionId && i < 200; i++) {
      await new Promise((done) => setTimeout(done, 10))
      Object.assign(
        run,
        routines.scheduler.snapshot().runs.find((r) => r.id === run.id),
      )
    }
    if (!run.sessionId) throw new Error('session missing')
    await expect(runtime.command(run.sessionId, { type: 'abort' })).rejects.toThrow('owned')
    await expect(runtime.stop(run.sessionId)).rejects.toThrow('routine owns')
    const state = await runtime.command(run.sessionId, { type: 'get_state' })
    if (!state.success || !state.data || !('sessionFile' in state.data) || !state.data.sessionFile)
      throw new Error('missing session path')
    await expect(
      runtime.start({ repository: root, sessionPath: state.data.sessionFile }),
    ).rejects.toThrow()
    expect(runtime.list()).toHaveLength(1)
    await expect(
      runtime.remove({ repository: root, sessionPath: state.data.sessionFile }),
    ).rejects.toThrow()
    await routines.execute({ type: 'routine.cancel', runId: run.id }, randomUUID(), ['routines'])
    expect(routines.scheduler.snapshot().runs.find((r) => r.id === run.id)?.status).toBe(
      'cancelled',
    )
  })
})

it('lists no routines and rejects saving against a repository on an empty Host', async () => {
  store.syncRepositories([])
  expect(await list()).toEqual([])
  await expect(
    routines.execute(
      { type: 'routine.save', routine: input(), expectedRevision: null },
      randomUUID(),
      control,
    ),
  ).rejects.toThrow('repository unavailable')
})
