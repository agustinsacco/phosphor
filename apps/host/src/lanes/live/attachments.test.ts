import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHostFrame, type HostFrame, type LaneEvent } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import type { PiEvent, RpcCommand, RpcResponse, RpcSessionState } from '@phosphor/shared/rpc'
import { openStore } from '../store'
import { createLiveLanes } from '../live'
import { createSubscriptions } from '../subscriptions'

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
describe('live attachment lifecycle', () => {
  it('keeps only latest settled timing, preserves earliest start and forgets on detach', async () => {
    let now = 100
    const s = await setup(undefined, () => now)
    await s.live.attach(s.laneId, 'pi').ready
    expect(s.live.receiptTiming(s.laneId)).toBeUndefined()
    s.push({ type: 'agent_start' })
    now = 200
    s.push({ type: 'agent_start' })
    s.push({ type: 'agent_end', messages: [] })
    now = 300
    s.push({ type: 'agent_settled', aborted: false })
    expect(s.live.receiptTiming(s.laneId)).toEqual({ start: 100, end: 300 })
    now = 400
    s.push({ type: 'agent_start' })
    expect(s.live.receiptTiming(s.laneId)).toEqual({ start: 100, end: 300 })
    now = 500
    s.push({ type: 'agent_settled', aborted: false })
    expect(s.live.receiptTiming(s.laneId)).toEqual({ start: 400, end: 500 })
    s.live.detach(s.laneId)
    expect(s.live.receiptTiming(s.laneId)).toBeUndefined()
  })
  it('resets early subscribers once after initial refresh, with events during the read and loaded transcript', async () => {
    const s = await setup()
    s.subscribe()
    await tick()
    let release: (response: RpcResponse) => void = () => {}
    s.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const attachment = s.live.attach(s.laneId, 'pi')
    s.push({ type: 'message_end', message: { role: 'user', content: 'during' } })
    release({
      type: 'response',
      command: 'get_messages',
      success: true,
      data: { messages: [{ role: 'user', content: 'loaded' }] },
    })
    await attachment.ready
    await tick()
    const resets = s.frames.filter((f) => f.type === 'snapshot' && f.reset)
    expect(resets).toHaveLength(1)
    expect(resets[0]).toMatchObject({
      snapshot: {
        messages: [
          { role: 'user', content: 'loaded' },
          { role: 'user', content: 'during' },
        ],
        cursor: s.live.streams.cursor(s.laneId),
      },
    })
    const cursor = s.live.streams.cursor(s.laneId)
    s.push({ type: 'turn_start' })
    await tick()
    expect(s.frames.at(-1)).toMatchObject({ type: 'event', cursor: { seq: cursor.seq + 1 } })
  })
  it('orders answered dialogs before their summary change, while timeout summaries still update', async () => {
    vi.useFakeTimers()
    const s = await setup()
    await s.live.attach(s.laneId, 'pi').ready
    const events: LaneEvent[] = []
    s.live.streams.listen(s.laneId, (frame) => {
      if (frame) events.push(frame.event)
    })
    const ask = () =>
      s.live.push(s.laneId, {
        kind: 'extension-ui',
        request: {
          type: 'extension_ui_request',
          id: 'dialog',
          method: 'input',
          title: 'ask',
          timeout: 10,
        },
      })
    ask()
    events.length = 0
    s.live.publish(s.laneId, { kind: 'dialog-resolved', dialogId: 'dialog' })
    expect(events.map((e) => e.kind)).toEqual(['dialog-resolved', 'summary'])
    expect(s.live.openDialogs(s.laneId)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    ask()
    events.length = 0
    vi.advanceTimersByTime(10)
    expect(events).toMatchObject([{ kind: 'summary', summary: { activity: 'idle' } }])
    expect(s.live.openDialogs(s.laneId)).toEqual([])
  })
  it('does not reset a replacement attachment when an old refresh finishes', async () => {
    const s = await setup()
    s.subscribe()
    await tick()
    let release: (response: RpcResponse) => void = () => {}
    s.command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const old = s.live.attach(s.laneId, 'old')
    s.live.detach(s.laneId)
    await s.live.attach(s.laneId, 'new').ready
    await tick()
    const resets = s.frames.filter((f) => f.type === 'snapshot' && f.reset).length
    release({ type: 'response', command: 'get_messages', success: true, data: { messages: [] } })
    await old.ready
    await tick()
    expect(s.frames.filter((f) => f.type === 'snapshot' && f.reset)).toHaveLength(resets)
    expect(s.live.sessionFor(s.laneId)).toBe('new')
  })
  it('rejects duplicate, unknown and over-cap attachments, and releases the slot on detach', async () => {
    const s = await setup()
    const lane = s.store.getLane(s.laneId)
    if (!lane) throw new Error('missing lane')
    const second = s.store.ensureLane({
      repositoryId: lane.repositoryId,
      cwd: lane.cwd,
      sessionFile: null,
    })
    const live = createLiveLanes({
      epoch,
      store: s.store,
      runtime: { command: s.command },
      now: Date.now,
      log: vi.fn(),
      limits: { lanesPerHost: 1 },
    })
    await live.attach(s.laneId, 'first').ready
    expect(() => live.attach(s.laneId, 'duplicate')).toThrow('already attached')
    expect(() => live.attach('12345678-1234-4234-8234-123456789012', 'unknown')).toThrow(
      'unknown lane',
    )
    expect(() => live.attach(second.laneId, 'second')).toThrow('capacity')
    s.store.markRemoved(s.laneId)
    live.forget(s.laneId)
    await live.attach(second.laneId, 'second').ready
    expect(live.sessionFor(second.laneId)).toBe('second')
    live.close()
  })
  it('never streams stderr; refreshes publish only changed summary, control publishes a delta, and forget removes viewers', async () => {
    const s = await setup()
    const attachment = s.live.attach(s.laneId, 'pi')
    await attachment.ready
    s.subscribe()
    s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: 'list' })
    await tick()
    const before = s.live.streams.cursor(s.laneId)
    s.live.push(s.laneId, { kind: 'stderr', text: 'private environment' })
    await attachment.stateChanged()
    expect(s.live.streams.cursor(s.laneId)).toEqual(before)
    s.command.mockResolvedValueOnce({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { ...state, sessionName: 'new' },
    })
    await attachment.stateChanged()
    await tick()
    expect(s.frames.some((f) => f.type === 'lanes-delta' && f.upsert[0]?.title === 'new')).toBe(
      true,
    )
    const control = s.store.takeControl(s.laneId, {
      clientId: '12345678-1234-4234-8234-123456789012',
      label: 'client',
    })
    s.live.publish(s.laneId, { kind: 'control', control })
    await tick()
    const events = s.frames.filter((f) => f.type === 'event')
    expect(events.slice(-2)).toMatchObject([
      { event: { kind: 'control' } },
      { event: { kind: 'summary', summary: { control } } },
    ])
    expect(s.live.sessionFor(s.laneId)).toBe('pi')
    s.store.markRemoved(s.laneId)
    s.live.forget(s.laneId)
    await tick()
    expect(s.frames.at(-1)).toMatchObject({ type: 'subscribe-failed', code: 'unknown-lane' })
    expect(s.frames.some((f) => f.type === 'lanes-delta' && f.remove.includes(s.laneId))).toBe(true)
    expect(JSON.stringify(s.frames)).not.toContain('private environment')
  })
})
