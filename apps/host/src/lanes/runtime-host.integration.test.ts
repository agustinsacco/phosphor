import { renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHostFrame, type HostFrame, type Receipt } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { fakeMachine, EXTENSIONS_ROOT, type FakeMachine } from '../__fixtures__/machine'
import { createHostRuntime, type HostRuntime } from '../session/runtime'
import { buildPiEnvironment } from '../machine/environment'
import { createHostLog } from '../machine/log'
import { isGone } from '../session/lifecycle'
import { createLaneCommands } from './commands'
import { createLaneCalls } from './calls'
import { createRuntimeLanes } from './runtime-host'
import { createLiveLanes } from './live'
import { openStore, type HostStore } from './store'
import { createUnattachedSnapshots } from './transcript'
import { createSubscriptions } from './subscriptions'

let machine: FakeMachine
let store: HostStore
let real: HostRuntime | undefined
let live: ReturnType<typeof createLiveLanes>
let repositoryId: string
beforeEach(async () => {
  machine = fakeMachine({ rpc: true })
  vi.stubEnv('PATH', process.env.PATH)
  vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  store = await openStore(join(machine.dir, 'state'), process.getuid?.())
  const repository = store.syncRepositories([machine.repository])[0]
  if (!repository) throw new Error('fixture')
  repositoryId = repository.id
})
afterEach(async () => {
  const drained = real?.drain('test finished')
  void real?.drain('test forced')
  await drained
  real = undefined
  live?.close()
  store.close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  machine.cleanup()
})
/** One Host over a real fake-pi runtime: lane commands, calls and the unattached reader. */
function boot() {
  const env = buildPiEnvironment({
    hostEnv: machine.hostEnv,
    nodePath: process.execPath,
    platform: process.platform,
  }).env
  const log = createHostLog(join(machine.dir, 'logs'), [])
  real = createHostRuntime(
    {
      pi: { binaryPath: process.execPath, prefixArgs: [machine.cli] },
      env,
      roots: [machine.repository],
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
      log,
    },
    { dialogs: 'forward' },
  )
  real.life.to('validating')
  real.life.to('ready')
  let reader: ReturnType<typeof createUnattachedSnapshots> = () => null
  live = createLiveLanes({
    epoch: '0123456789abcdef',
    store,
    runtime: real,
    now: Date.now,
    log: vi.fn(),
    unattached: (id) => reader(id),
  })
  reader = createUnattachedSnapshots({
    store,
    summary: live.summaryFor,
    cursor: live.streams.cursor,
    sessionsRoot: join(machine.agentDir, 'sessions'),
    log: vi.fn(),
  })
  const binding = createRuntimeLanes({ runtime: real, store, live, log: log.write })
  const receipts: Receipt[] = []
  const commands = createLaneCommands({
    store,
    ...binding,
    runtime: binding,
    sessionFor: live.sessionFor,
    openDialogs: live.openDialogs,
    summaryFor: live.summaryFor,
    publish: live.publish,
    deliver: (_id, receipt) => receipts.push(receipt),
    now: Date.now,
    log: log.write,
  })
  const calls = createLaneCalls({
    store,
    live,
    runtime: real,
    unattached: (id) => reader(id),
    now: Date.now,
    log: log.write,
  })
  const client = { id: randomUUID(), label: 'Client', caps: ['sessions.control'] as const }
  return { runtime: real, binding, commands, calls, client, receipts }
}
describe('runtime lane binding', () => {
  it('creates, queries and stops a lane at thinking level max', async () => {
    const { commands, calls, client, receipts, binding } = boot()
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      op: { type: 'lane.create', repositoryId, worktree: null, thinkingLevel: 'max' },
    })
    const receipt = receipts.at(-1)
    if (receipt?.status !== 'done' || !receipt.laneId) throw new Error('lane at max not created')
    const laneId = receipt.laneId
    expect(await calls.call('lane.state', { laneId })).toMatchObject({
      ok: true,
      data: { thinkingLevel: 'max' },
    })
    const sessionId = live.sessionFor(laneId)
    if (!sessionId) throw new Error('missing session')
    await binding.command(sessionId, { type: 'prompt', message: 'hello' })
    const answered = async () => {
      const read = await calls.call('lane.messages', { laneId })
      return read.ok && (read.data as { messages: unknown[] }).messages.length === 2
    }
    for (let i = 0; i < 300 && !(await answered()); i++) await sleep(10)
    expect(await answered()).toBe(true)
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      laneId,
      fence: 1,
      op: { type: 'lane.stop' },
    })
    expect(receipts.at(-1)).toMatchObject({ status: 'done' })
    expect(live.sessionFor(laneId)).toBeNull()
  })
  it('creates, streams, stops, reads, resumes and drains a real fake-pi process', async () => {
    const { runtime: real, binding, commands, calls, client, receipts } = boot()
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      op: { type: 'lane.create', repositoryId, worktree: null },
    })
    const receipt = receipts.at(-1)
    if (receipt?.status !== 'done' || !receipt.laneId) throw new Error('missing created lane')
    const laneId = receipt.laneId
    const pair = createLoopbackPair()
    const frames: HostFrame[] = []
    pair.client.onMessage((text) => {
      const frame = parseHostFrame(text)
      if (!frame.ok) throw new Error('invalid frame')
      frames.push(frame.value)
    })
    const subscriptions = createSubscriptions(pair.server, live.streams, live.lanesTopic)
    subscriptions.handle({ type: 'subscribe', id: 'watch', topic: 'lane', laneId })
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      laneId,
      fence: 1,
      op: { type: 'prompt', message: 'hello' },
    })
    for (
      let i = 0;
      i < 300 &&
      !frames.some(
        (f) =>
          f.type === 'event' &&
          f.event.kind === 'pi' &&
          f.event.push.kind === 'event' &&
          f.event.push.event.type === 'agent_end',
      );
      i++
    )
      await sleep(10)
    expect(
      frames.some(
        (f) =>
          f.type === 'event' &&
          f.event.kind === 'pi' &&
          f.event.push.kind === 'event' &&
          f.event.push.event.type === 'agent_end',
      ),
    ).toBe(true)
    const pids = real.list().map((s) => s.pid)
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      laneId,
      fence: 1,
      op: { type: 'lane.stop' },
    })
    expect(await calls.call('lane.messages', { laneId })).toMatchObject({
      ok: true,
      data: { messages: [{ role: 'user' }, { role: 'assistant' }] },
    })
    const recorded = store.getLane(laneId)?.sessionFile
    if (!recorded) throw new Error('missing recorded file')
    renameSync(recorded, `${recorded}.saved`)
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      laneId,
      fence: 1,
      op: { type: 'lane.resume' },
    })
    expect(receipts.at(-1)).toMatchObject({
      status: 'failed',
      error: { code: 'internal', message: 'the lane could not start' },
    })
    expect(real.list()).toEqual([])
    renameSync(`${recorded}.saved`, recorded)
    await commands.submit(client, {
      type: 'command',
      requestId: randomUUID(),
      laneId,
      fence: 1,
      op: { type: 'lane.resume' },
    })
    expect(receipts.at(-1)).toMatchObject({ status: 'done', fence: 1 })
    expect(await calls.call('lane.messages', { laneId })).toMatchObject({
      ok: true,
      data: { messages: [{ role: 'user' }, { role: 'assistant' }] },
    })
    pids.push(...real.list().map((s) => s.pid))
    const endedBefore = frames.filter(
      (f) =>
        f.type === 'event' &&
        f.event.kind === 'pi' &&
        f.event.push.kind === 'event' &&
        f.event.push.event.type === 'agent_end',
    ).length
    const sessionId = live.sessionFor(laneId)
    if (!sessionId) throw new Error('missing resumed session')
    await binding.command(sessionId, { type: 'prompt', message: 'stream' })
    for (let i = 0; i < 300 && live.summaryFor(laneId)?.activity !== 'working'; i++) await sleep(10)
    expect(live.summaryFor(laneId)?.activity).toBe('working')
    await binding.stopLane(laneId)
    await Promise.resolve()
    expect(
      frames.filter(
        (f) =>
          f.type === 'event' &&
          f.event.kind === 'pi' &&
          f.event.push.kind === 'event' &&
          f.event.push.event.type === 'agent_end',
      ),
    ).toHaveLength(endedBefore + 1)
    expect(await calls.call('lane.messages', { laneId })).toMatchObject({
      ok: true,
      data: {
        messages: [
          { role: 'user' },
          { role: 'assistant' },
          { role: 'user' },
          { role: 'assistant' },
        ],
      },
    })
    const lane = store.getLane(laneId)
    if (!lane) throw new Error('missing lane')
    await binding.resumeLane(lane)
    pids.push(...real.list().map((s) => s.pid))
    expect((await real.drain('integration finished')).state).toBe('stopped')
    await commands.close()
    subscriptions.close()
    pair.client.close(1000, 'test finished')
    expect(real.list()).toEqual([])
    for (const pid of pids) if (pid !== undefined) expect(isGone(pid)).toBe(true)
  })
})
