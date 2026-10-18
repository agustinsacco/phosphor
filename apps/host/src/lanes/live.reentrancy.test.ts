import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHostFrame, type HostFrame } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import type { PiEvent, RpcCommand, RpcResponse, RpcSessionState } from '@phosphor/shared/rpc'
import { openStore } from './store'
import { createLiveLanes } from './live'
import { createSubscriptions } from './subscriptions'

const epoch = '0123456789abcdef'
const state: RpcSessionState = {
  sessionId: 'pi',
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
}
const cleanups: (() => void)[] = []
const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
async function setup(sendQueueBytes = 32 * 1024 * 1024, now = () => Date.UTC(2026, 9, 13)) {
  const dir = mkdtempSync(join(tmpdir(), 'host-live-'))
  const stateDir = join(dir, 'state')
  const store = await openStore(stateDir, process.getuid?.(), { now: () => Date.UTC(2026, 9, 13) })
  const repository = store.syncRepositories([dir])[0]
  if (!repository) throw new Error('no repository')
  const lane = store.ensureLane({ repositoryId: repository.id, cwd: dir, sessionFile: null })
  const command = vi.fn(async (_session: string, command: RpcCommand): Promise<RpcResponse> => ({
    type: 'response',
    command: command.type,
    success: true,
    data: command.type === 'get_messages' ? { messages: [] } : state,
  }))
  const log = vi.fn()
  const live = createLiveLanes({
    epoch,
    store,
    runtime: { command },
    now,
    log,
    limits: { replayEvents: 3 },
    unattached(id) {
      if (id !== lane.laneId) return null
      return {
        ok: true,
        snapshot: {
          cursor: live.streams.cursor(id),
          summary: lane,
          state: null,
          messages: [],
          pending: [],
          dialogs: [],
          ui: [],
        },
      }
    },
  })
  const pair = createLoopbackPair()
  const frames: HostFrame[] = []
  pair.client.onMessage((text) => {
    const parsed = parseHostFrame(text)
    if (!parsed.ok) throw new Error('invalid frame')
    frames.push(parsed.value)
  })
  const subscriptions = createSubscriptions(pair.server, live.streams, live.lanesTopic, {
    sendQueueBytes,
  })
  cleanups.push(() => {
    subscriptions.close()
    live.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const push = (event: PiEvent) => live.push(lane.laneId, { kind: 'event', event })
  const subscribe = (id = 's', after?: { epoch: string; seq: number }) =>
    subscriptions.handle({ type: 'subscribe', topic: 'lane', laneId: lane.laneId, id, after })
  const snapshot = () => {
    const result = live.streams.snapshot(lane.laneId)
    if (!result?.ok) throw new Error('snapshot failed')
    return result.snapshot
  }
  return {
    live,
    log,
    store,
    command,
    laneId: lane.laneId,
    frames,
    pair,
    subscriptions,
    subscribe,
    push,
    snapshot,
    stateDir,
  }
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.useRealTimers()
})
describe('live lane review guards', () => {
  it.each(['needs-input', 'finished'] as const)(
    'serializes reentrant %s transitions and never rolls counters back',
    async (kind) => {
      const s = await setup()
      await s.live.attach(s.laneId, 'pi').ready
      const counters: number[] = []
      s.live.streams.listen(s.laneId, (frame) => {
        if (frame?.event.kind === 'summary') counters.push(frame.event.summary.attention)
      })
      const attention: number[] = []
      s.live.lanesTopic.listen((frame) => {
        if (frame?.type !== 'attention') return
        attention.push(frame.event.attention)
        if (attention.length === 1) s.push({ type: 'queue_update', steering: [], followUp: [] })
      })
      if (kind === 'finished') {
        s.push({ type: 'agent_start' })
        s.push({ type: 'agent_settled', aborted: false })
      } else
        s.live.push(s.laneId, {
          kind: 'extension-ui',
          request: { type: 'extension_ui_request', id: 'ask', method: 'input', title: 'ask' },
        })
      expect(attention).toEqual([1])
      expect(s.store.getLane(s.laneId)?.attention).toBe(1)
      expect(counters.at(-1)).toBe(1)
      expect(counters).toEqual([...counters].sort((a, b) => a - b))
    },
  )
  it('publishes the detached stored summary so existing lane and list viewers agree with new viewers', async () => {
    const s = await setup()
    await s.live.attach(s.laneId, 'pi').ready
    expect(s.live.summaryFor(s.laneId)?.activity).toBe('idle')
    s.subscribe('lane')
    s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: 'old-list' })
    await tick()
    s.frames.length = 0
    s.live.detach(s.laneId)
    s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: 'new-list' })
    await tick()
    const stored = s.live.summaryFor(s.laneId)
    expect(stored?.activity).toBe('stopped')
    expect(s.frames).toMatchObject([
      { type: 'event', id: 'lane', event: { kind: 'summary', summary: stored } },
      { type: 'lanes-delta', id: 'old-list', upsert: [stored] },
      { type: 'lanes', id: 'new-list', lanes: [stored] },
    ])
    expect(s.frames).toHaveLength(3)
  })
})

it('bounds dirty transition passes, logs only the lane id and reconciles every viewer next macrotask', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] })
  const s = await setup()
  await s.live.attach(s.laneId, 'pi').ready
  for (const id of ['one', 'two']) {
    s.subscribe(`lane-${id}`)
    s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: `list-${id}` })
  }
  await tick()
  s.frames.length = 0
  let summaries = 0
  const drop = s.live.lanesTopic.listen((frame) => {
    if (frame?.type !== 'lanes-delta') return
    summaries++
    s.push(
      frame.upsert[0]?.activity === 'working'
        ? { type: 'agent_settled', aborted: false }
        : { type: 'agent_start' },
    )
  })
  s.push({ type: 'agent_start' })
  drop()
  expect(summaries).toBe(3)
  expect(s.log.mock.calls).toEqual([['lane.stream_reentrant_overflow', { laneId: s.laneId }]])
  await tick()
  expect(s.frames.findLast((f) => f.type === 'lanes-delta')).toMatchObject({
    upsert: [{ activity: 'working' }],
  })
  expect(s.live.summaryFor(s.laneId)?.activity).toBe('idle')
  await vi.advanceTimersToNextTimerAsync()
  s.subscribe('new-lane')
  s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: 'new-list' })
  await tick()
  const summary = s.live.summaryFor(s.laneId)
  expect(summary).toMatchObject({ activity: 'idle', attention: 2 })
  for (const id of ['one', 'two']) {
    expect(
      s.frames.findLast(
        (f) => f.type === 'event' && f.id === `lane-${id}` && f.event.kind === 'summary',
      ),
    ).toMatchObject({ event: { kind: 'summary', summary } })
    expect(
      s.frames.findLast((f) => f.type === 'lanes-delta' && f.id === `list-${id}`),
    ).toMatchObject({ upsert: [summary] })
  }
  expect(s.frames.find((f) => f.type === 'snapshot' && f.id === 'new-lane')).toMatchObject({
    snapshot: { summary },
  })
  expect(s.frames.find((f) => f.type === 'lanes' && f.id === 'new-list')).toMatchObject({
    lanes: [summary],
  })
  expect(s.frames.findLast((f) => f.type === 'attention')).toMatchObject({
    event: { attention: s.store.getLane(s.laneId)?.attention },
  })
})

it('keeps one pending reconciliation and a fresh bounded batch per macrotask until listeners stop', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] })
  const s = await setup()
  await s.live.attach(s.laneId, 'pi').ready
  let summaries = 0
  const drop = s.live.lanesTopic.listen((frame) => {
    if (frame?.type !== 'lanes-delta') return
    summaries++
    s.push(
      frame.upsert[0]?.activity === 'working'
        ? { type: 'agent_settled', aborted: false }
        : { type: 'agent_start' },
    )
  })
  const scheduled = vi.spyOn(globalThis, 'setImmediate')
  const delta = vi.spyOn(s.live.lanesTopic, 'delta')
  cleanups.push(() => scheduled.mockRestore())
  s.push({ type: 'agent_start' })
  expect(summaries).toBe(3)
  expect(scheduled).toHaveBeenCalledTimes(1)
  s.push({ type: 'queue_update', steering: [], followUp: [] })
  expect(summaries).toBe(6)
  expect(scheduled).toHaveBeenCalledTimes(1)
  await vi.advanceTimersToNextTimerAsync()
  expect(summaries).toBe(9)
  expect(scheduled).toHaveBeenCalledTimes(2)
  drop()
  await vi.advanceTimersToNextTimerAsync()
  expect(summaries).toBe(9)
  expect(scheduled).toHaveBeenCalledTimes(2)
  expect(s.live.summaryFor(s.laneId)).toMatchObject({ activity: 'idle', attention: 5 })
  expect(delta.mock.calls.at(-1)?.[0]).toEqual([s.live.summaryFor(s.laneId)])
  expect(s.store.getLane(s.laneId)?.attention).toBe(5)
  expect(s.log.mock.calls).toHaveLength(3)
})

it.each(['detach', 'reattach'] as const)(
  'ignores a pending reconciliation after %s instead of reading a different attachment',
  async (action) => {
    vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] })
    const s = await setup()
    await s.live.attach(s.laneId, 'old').ready
    const drop = s.live.lanesTopic.listen((frame) => {
      if (frame?.type === 'lanes-delta')
        s.push(
          frame.upsert[0]?.activity === 'working'
            ? { type: 'agent_settled', aborted: false }
            : { type: 'agent_start' },
        )
    })
    s.push({ type: 'agent_start' })
    drop()
    s.live.detach(s.laneId)
    if (action === 'reattach') await s.live.attach(s.laneId, 'new').ready
    await tick()
    const getLane = vi.spyOn(s.store, 'getLane')
    const publish = vi.spyOn(s.live.streams, 'publish')
    const delta = vi.spyOn(s.live.lanesTopic, 'delta')
    await vi.advanceTimersToNextTimerAsync()
    expect(getLane).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(delta).not.toHaveBeenCalled()
    expect(s.live.sessionFor(s.laneId)).toBe(action === 'reattach' ? 'new' : null)
  },
)

describe('live lane summary supersession guards', () => {
  it.each(['control', 'detach'] as const)(
    'keeps every viewer on the newer summary after reentrant attention %s',
    async (action) => {
      const s = await setup()
      await s.live.attach(s.laneId, 'pi').ready
      for (const id of ['one', 'two']) {
        s.subscribe(`lane-${id}`)
        s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: `list-${id}` })
      }
      await tick()
      s.frames.length = 0
      s.live.lanesTopic.listen((frame) => {
        if (frame?.type !== 'attention') return
        if (action === 'detach') s.live.detach(s.laneId)
        else {
          const control = s.store.takeControl(s.laneId, {
            clientId: '12345678-1234-4234-8234-123456789012',
            label: 'new controller',
          })
          s.live.publish(s.laneId, { kind: 'control', control })
        }
      })
      s.live.push(s.laneId, {
        kind: 'extension-ui',
        request: { type: 'extension_ui_request', id: 'ask', method: 'input', title: 'ask' },
      })
      await tick()
      const expected = s.live.summaryFor(s.laneId)
      expect(expected).toMatchObject(
        action === 'detach'
          ? { activity: 'stopped', attention: 1 }
          : { control: { controller: { label: 'new controller' } }, attention: 1 },
      )
      for (const id of ['one', 'two']) {
        const laneSummaries = s.frames.flatMap((frame) =>
          frame.type === 'event' && frame.id === `lane-${id}` && frame.event.kind === 'summary'
            ? [frame.event.summary]
            : [],
        )
        const listSummaries = s.frames.flatMap((frame) =>
          frame.type === 'lanes-delta' && frame.id === `list-${id}` ? frame.upsert : [],
        )
        expect(laneSummaries).toEqual([expected])
        expect(listSummaries).toEqual([expected])
      }
    },
  )
  it.each(['attached', 'detached'] as const)(
    'does not send a superseded summary delta for an %s lane',
    async (attachment) => {
      const s = await setup()
      if (attachment === 'attached') await s.live.attach(s.laneId, 'pi').ready
      s.subscribe()
      s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: 'list' })
      await tick()
      s.frames.length = 0
      const summary = s.live.summaryFor(s.laneId)
      if (!summary) throw new Error('no summary')
      const newer = { ...summary, title: 'newer' }
      s.live.streams.listen(s.laneId, (frame) => {
        if (frame?.event.kind === 'summary' && frame.event.summary.title === 'older')
          s.live.publish(s.laneId, { kind: 'summary', summary: newer })
      })
      s.live.publish(s.laneId, { kind: 'summary', summary: { ...summary, title: 'older' } })
      await tick()
      const deltas = s.frames.filter((frame) => frame.type === 'lanes-delta')
      expect(deltas).toMatchObject([{ upsert: [newer] }])
      expect(deltas).toHaveLength(1)
      expect(s.frames.filter((frame) => frame.type === 'event').at(-1)).toMatchObject({
        event: { kind: 'summary', summary: newer },
      })
    },
  )
  it('commits the control summary so an unchanged push publishes no duplicate summary', async () => {
    const s = await setup()
    await s.live.attach(s.laneId, 'pi').ready
    const control = s.store.takeControl(s.laneId, {
      clientId: '12345678-1234-4234-8234-123456789012',
      label: 'controller',
    })
    s.live.publish(s.laneId, { kind: 'control', control })
    const publish = vi.spyOn(s.live.streams, 'publish')
    const delta = vi.spyOn(s.live.lanesTopic, 'delta')
    s.push({ type: 'queue_update', steering: [], followUp: [] })
    expect(publish.mock.calls.map(([, event]) => event.kind)).toEqual(['pi'])
    expect(delta).not.toHaveBeenCalled()
  })
  it('publishes nothing when detaching a lane that is already unattached', async () => {
    const s = await setup()
    const publish = vi.spyOn(s.live.streams, 'publish')
    const delta = vi.spyOn(s.live.lanesTopic, 'delta')
    const cursor = s.live.streams.cursor(s.laneId)
    s.live.detach(s.laneId)
    expect(publish).not.toHaveBeenCalled()
    expect(delta).not.toHaveBeenCalled()
    expect(s.live.streams.cursor(s.laneId)).toEqual(cursor)
  })
})
