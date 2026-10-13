import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseHostFrame,
  type HostFrame,
  type LaneSnapshot,
  type LaneEvent,
} from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import type { PiEvent, RpcCommand, RpcResponse, RpcSessionState } from '@phosphor/shared/rpc'
import { createLaneProjection } from '@phosphor/session-runtime/lanes/projection'
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
function fields(snapshot: LaneSnapshot) {
  const { summary: _summary, cursor: _cursor, ...projection } = snapshot
  return projection
}
async function setup(sendQueueBytes = 32 * 1024 * 1024) {
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
  const live = createLiveLanes({
    epoch,
    store,
    runtime: { command },
    now: () => Date.UTC(2026, 9, 13),
    log: vi.fn(),
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
describe('live lane binding', () => {
  it('applies and publishes in one synchronous step; late and reset viewers equal the early projection', async () => {
    vi.useFakeTimers()
    const s = await setup(10000)
    await s.live.attach(s.laneId, 'pi').ready
    s.subscribe('early')
    await tick()
    const reference = createLaneProjection({ now: () => 0, overflow: () => {} })
    reference.settle([], state)
    const published: { seq: number; event: LaneEvent }[] = []
    const cuts: { actual: unknown; expected: unknown }[] = []
    s.live.streams.listen(s.laneId, (frame) => {
      if (!frame) return
      published.push({ seq: frame.cursor.seq, event: frame.event })
      if (frame.event.kind === 'pi') reference.apply(frame.event.push)
      cuts.push({
        actual: { cursor: s.snapshot().cursor, fields: fields(s.snapshot()) },
        expected: { cursor: frame.cursor, fields: reference.view() },
      })
    })
    const trace: PiEvent[] = [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world' },
      },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
      },
      { type: 'agent_end', messages: [] },
    ]
    for (const event of trace.slice(0, 4)) s.push(event)
    const cut = s.snapshot()
    expect(fields(cut)).toEqual(reference.view())
    s.subscribe('late')
    await tick()
    for (const event of trace.slice(4)) s.push(event)
    await tick()
    const suffix = published.filter((e) => e.seq > cut.cursor.seq)
    const received = s.frames.filter((f) => f.type === 'event' && f.id === 'late')
    expect(
      received.map((f) => f.type === 'event' && { seq: f.cursor.seq, event: f.event }),
    ).toEqual(suffix)
    expect(suffix.map((e) => e.seq)).toEqual(
      Array.from({ length: suffix.length }, (_, i) => cut.cursor.seq + i + 1),
    )
    s.subscribe('evicted', { epoch, seq: 0 })
    await tick()
    expect(s.frames.find((f) => f.type === 'snapshot' && f.id === 'evicted')).toMatchObject({
      reset: true,
      snapshot: s.snapshot(),
    })
    expect(fields(s.snapshot())).toEqual(reference.view())
    // The paused subscriber resets to the same composed projection at its reset cursor.
    s.pair.pause()
    for (let n = 0; n < 100; n++) s.push({ type: 'queue_update', steering: [], followUp: [] })
    expect(fields(s.snapshot())).toEqual(reference.view())
    const before = s.live.streams.cursor(s.laneId).seq
    expect(before).toBe(published.at(-1)?.seq)
    expect(s.subscriptions.queuedBytes()).toBe(0)
    s.pair.resume()
    await tick()
    vi.advanceTimersByTime(25)
    await tick()
    const reset = s.frames.findLast((f) => f.type === 'snapshot' && f.id === 'early')
    expect(reset).toMatchObject({ reset: true, snapshot: s.snapshot() })
    for (const cut of cuts) expect(cut.actual).toEqual(cut.expected)
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
  it('resets after failed initial refresh too, and supplies no fabricated unattached transcript', async () => {
    const s = await setup()
    s.subscribe()
    await tick()
    s.command.mockRejectedValueOnce(new Error('private'))
    await s.live.attach(s.laneId, 'pi').ready
    await tick()
    expect(s.frames.filter((f) => f.type === 'snapshot' && f.reset)).toHaveLength(1)
    const separate = createLiveLanes({
      epoch,
      store: s.store,
      runtime: { command: s.command },
      now: Date.now,
      log: vi.fn(),
    })
    expect(separate.streams.snapshot(s.laneId)).toBeNull()
    expect(separate.summaryFor(s.laneId)?.activity).toBe('stopped')
    separate.close()
  })
  it('publishes attention once per run, needs-input transition and failure; counters persist', async () => {
    const s = await setup()
    await s.live.attach(s.laneId, 'pi').ready
    s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: 'list' })
    s.subscribe()
    await tick()
    s.push({ type: 'agent_start' })
    s.push({ type: 'agent_end', messages: [], willRetry: true })
    expect(s.store.getLane(s.laneId)?.attention).toBe(0)
    s.push({ type: 'agent_settled' })
    s.push({ type: 'agent_settled' })
    const ask = (id: string) =>
      s.live.push(s.laneId, {
        kind: 'extension-ui',
        request: { type: 'extension_ui_request', id, method: 'input', title: 'ask' },
      })
    ask('a')
    ask('b')
    expect(s.live.openDialogs(s.laneId)).toEqual(['a', 'b'])
    s.live.publish(s.laneId, { kind: 'dialog-resolved', dialogId: 'a' })
    s.live.publish(s.laneId, { kind: 'dialog-resolved', dialogId: 'b' })
    ask('c')
    s.live.push(s.laneId, { kind: 'exit', code: 1, signal: null, expected: false })
    const exitedCursor = s.live.streams.cursor(s.laneId)
    s.live.push(s.laneId, { kind: 'exit', code: 1, signal: null, expected: false })
    s.push({ type: 'agent_start' })
    expect(s.live.streams.cursor(s.laneId)).toEqual(exitedCursor)
    expect(s.live.sessionFor(s.laneId)).toBeNull()
    expect(s.live.openDialogs(s.laneId)).toEqual([])
    await tick()
    const attention = s.frames.flatMap((f) => (f.type === 'attention' ? [f.event] : []))
    expect(attention.map((e) => e.kind)).toEqual([
      'finished',
      'needs-input',
      'needs-input',
      'failed',
    ])
    expect(attention.map((e) => e.id)).toEqual([1, 2, 3, 4].map((n) => `${s.laneId}:${n}`))
    expect(s.snapshot().summary.attention).toBe(4)
    s.store.markRead(s.laneId, 4)
    const reopened = await openStore(s.stateDir, process.getuid?.())
    expect(reopened.getLane(s.laneId)).toMatchObject({ attention: 4, read: 4 })
    reopened.close()
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
  it('falls back for invalid live metadata and stored branches without changing values', async () => {
    const s = await setup()
    s.store.updateLane(s.laneId, {
      title: 'stored',
      provider: 'provider',
      model: 'stored-model',
      branch: 'b'.repeat(201),
    })
    const attachment = s.live.attach(s.laneId, 'pi')
    await attachment.ready
    expect(s.live.summaryFor(s.laneId)).toMatchObject({
      title: 'stored',
      model: { id: 'stored-model' },
      branch: null,
    })
    const model = {
      provider: 'provider',
      id: 'valid',
      name: 'model',
      api: 'api',
      reasoning: false,
      input: ['text'],
      contextWindow: 200000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    for (const [index, name] of ['x'.repeat(300), 'bad\u0001name'].entries()) {
      s.command.mockResolvedValueOnce({
        type: 'response',
        command: 'get_state',
        success: true,
        data: { ...state, sessionName: name, model: { ...model, id: `valid-${index}` } },
      })
      await attachment.stateChanged()
      expect(s.live.summaryFor(s.laneId)).toMatchObject({
        title: 'stored',
        model: { id: `valid-${index}` },
        branch: null,
      })
    }
    s.command.mockResolvedValueOnce({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { ...state, sessionName: 'valid-title', model: { ...model, id: 'x'.repeat(201) } },
    })
    await attachment.stateChanged()
    expect(s.live.summaryFor(s.laneId)).toMatchObject({
      title: 'valid-title',
      model: { id: 'stored-model' },
    })
    s.command.mockResolvedValueOnce({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { ...state, sessionName: 'x'.repeat(300) },
    })
    await attachment.stateChanged()
    s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: 'list' })
    await tick()
    s.push({ type: 'agent_start' })
    s.push({ type: 'agent_end', messages: [] })
    await tick()
    expect(s.frames.find((f) => f.type === 'attention')).toMatchObject({
      event: { title: 'stored' },
    })
  })
  it('rejects invalid summaries at the final wire check and logs only lane id', async () => {
    const s = await setup()
    const log = vi.fn()
    const live = createLiveLanes({
      epoch,
      store: s.store,
      runtime: { command: s.command },
      now: Date.now,
      log,
    })
    await live.attach(s.laneId, 'pi').ready
    const summary = live.summaryFor(s.laneId)
    if (!summary) throw new Error('no summary')
    const publish = vi.spyOn(live.streams, 'publish')
    const delta = vi.spyOn(live.lanesTopic, 'delta')
    live.publish(s.laneId, {
      kind: 'summary',
      summary: { ...summary, read: 1, title: 'hidden-value' },
    })
    expect(publish).not.toHaveBeenCalled()
    expect(delta).not.toHaveBeenCalled()
    const lane = s.store.getLane(s.laneId)
    if (!lane) throw new Error('no lane')
    vi.spyOn(s.store, 'getLane').mockReturnValue({ ...lane, read: 1 })
    expect(live.summaryFor(s.laneId)).toEqual(summary)
    expect(log.mock.calls).toEqual([
      ['lane.summary_invalid', { laneId: s.laneId }],
      ['lane.summary_invalid', { laneId: s.laneId }],
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain('hidden-value')
    live.close()
  })
  it('accepts exact wire metadata limits and suppresses attention for compaction and expected stop', async () => {
    const s = await setup()
    s.store.updateLane(s.laneId, { title: 't'.repeat(80), branch: 'b'.repeat(200) })
    const attachment = s.live.attach(s.laneId, 'pi')
    await attachment.ready
    s.command.mockResolvedValueOnce({
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        ...state,
        sessionName: 'n'.repeat(80),
        model: { provider: 'p'.repeat(200), id: 'm'.repeat(200) },
      },
    })
    await attachment.stateChanged()
    expect(s.live.summaryFor(s.laneId)).toMatchObject({
      title: 'n'.repeat(80),
      branch: 'b'.repeat(200),
      model: { provider: 'p'.repeat(200), id: 'm'.repeat(200) },
    })
    s.push({ type: 'compaction_start', reason: 'manual' })
    s.push({ type: 'compaction_end', reason: 'manual', result: null, aborted: true })
    await attachment.refresh()
    s.live.push(s.laneId, { kind: 'exit', code: 0, signal: null, expected: true })
    expect(s.store.getLane(s.laneId)?.attention).toBe(0)
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
})
