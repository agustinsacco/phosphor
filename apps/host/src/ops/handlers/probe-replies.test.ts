import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSkillsFeature } from '../../features/skills'
import type { MachinePorts } from '../../features/machine'
import { createLaneCalls } from '../../lanes/calls'
import { openStore, type HostStore } from '../../lanes/store'
import { createOpsService, type OpsService } from '../service'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (original) => ({ ...(await original<object>()), spawn }))

let directory: string
let store: HostStore
let service: OpsService | undefined
const log = vi.fn()
const laneId = '00000000-0000-4000-8000-000000000002'
const machineId = '00000000-0000-4000-8000-000000000001'
const uid = process.getuid?.()
const pi = {
  launch: { binaryPath: process.execPath, prefixArgs: [], version: '1' },
  environment: { env: {}, secrets: [], names: [], ambient: [], unset: [] },
}

beforeEach(async () => {
  vi.resetAllMocks()
  directory = await mkdtemp(join(tmpdir(), 'probe-replies-'))
  store = await openStore(join(directory, 'state'), uid, {})
}, 30_000)
afterEach(async () => {
  vi.useRealTimers()
  service?.close()
  service = undefined
  store.close()
  await rm(directory, { recursive: true, force: true })
})

async function start(ports: MachinePorts = { pi }) {
  const feature = createSkillsFeature({ store, env: {}, home: directory, log }, ports)
  const state = await createOpsService({
    stateDirectory: join(directory, 'state'),
    uid,
    store,
    selfIds: () => [machineId],
    enrolledId: () => machineId,
    lanes: { calls: createLaneCalls({ features: [feature] } as never) } as never,
    daemonLanes: {
      list: () => [],
      summary: () => null,
      sessionFor: (id) => (id === laneId ? 's1' : null),
    },
    shellEnvironment: null,
    editing: {} as never,
    command: async () => ({ success: true }),
    unattended: () => false,
    log,
  })
  service = state
  return {
    feature,
    run: (op: string, clientId = 'cli') =>
      state.dispatcher.run({ kind: 'local', clientId }, { op, args: {} }),
  }
}

function worker(body: (child: ChildProcess) => void) {
  return () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      pid: undefined,
    }) as unknown as ChildProcess
    queueMicrotask(() => body(child))
    return child
  }
}

it.each([
  { event: 'spawn', cause: 'spawn', text: /child failed to start/ },
  { event: 'decode', cause: 'decode', text: /protocol error/ },
])(
  'reports $cause failures through the op reply without leaking worker output',
  async ({ event, cause, text }) => {
    spawn.mockImplementationOnce(
      worker((child) => {
        if (event === 'spawn') child.emit('error', new Error('private fixture detail'))
        else child.stdout?.emit('data', Buffer.from('private fixture detail\n'))
      }),
    )
    const { run } = await start()
    const reply = await run('machine.commands')
    expect(reply).toMatchObject({ status: 'denied', code: 'unavailable', text })
    expect(JSON.stringify(reply)).not.toContain('private fixture detail')
    expect(log).toHaveBeenCalledWith('feature.failed', expect.objectContaining({ cause }))
  },
)

it('names the child timeout phase and accepts a later request', async () => {
  const { run } = await start()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let startWorker!: () => void
  const started = new Promise<void>((resolve) => {
    startWorker = resolve
  })
  spawn
    .mockImplementationOnce(
      worker((child) => {
        child.emit('spawn')
        startWorker()
      }),
    )
    .mockImplementationOnce(
      worker((child) =>
        child.stdout?.emit(
          'data',
          Buffer.from('{"type":"response","id":"feature","success":true,"data":{"commands":[]}}\n'),
        ),
      ),
    )
  const reply = run('machine.commands')
  await started
  await vi.advanceTimersByTimeAsync(23_000)
  expect(await reply).toMatchObject({
    status: 'denied',
    code: 'unavailable',
    text: /timed out during pi reply after 23s/,
  })
  expect(await run('machine.commands')).toMatchObject({ status: 'ok' })
})

it('explains a full queue and a distinct queue expiration through op replies', async () => {
  const { feature, run } = await start({ inspect: () => new Promise(() => {}) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const held = Array.from({ length: 7 }, () => feature.call('machine.providers', {}))
  let admitted!: () => void
  const called = new Promise<void>((resolve) => {
    admitted = resolve
  })
  const call = feature.call.bind(feature)
  vi.spyOn(feature, 'call').mockImplementationOnce((...args) => {
    const waiting = call(...args)
    admitted()
    return waiting
  })
  const waiting = run('machine.providers')
  await called
  expect(await run('machine.providers', 'second-cli')).toMatchObject({
    status: 'denied',
    text: /queue is full/,
  })
  await vi.advanceTimersByTimeAsync(29_000)
  expect(await waiting).toMatchObject({
    status: 'denied',
    text: /timed out in the queue after 29s/,
  })
  await Promise.all(held)
})
