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
async function setup() {
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
    now: () => Date.UTC(2026, 9, 13),
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
    sendQueueBytes: 32 * 1024 * 1024,
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
    subscriptions,
    subscribe,
    push,
    snapshot,
  }
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.useRealTimers()
})
describe('live lane public contract', () => {
  it('publishes attention once per run, needs-input transition and failure; counters persist', async () => {
    const s = await setup()
    await s.live.attach(s.laneId, 'pi').ready
    s.subscriptions.handle({ type: 'subscribe', topic: 'lanes', id: 'list' })
    s.subscribe()
    await tick()
    s.push({ type: 'agent_start' })
    s.push({ type: 'agent_end', messages: [], willRetry: true })
    expect(s.store.getLane(s.laneId)?.attention).toBe(0)
    s.push({ type: 'agent_settled', aborted: false })
    s.push({ type: 'agent_settled', aborted: false })
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
    expect(s.store.getLane(s.laneId)).toMatchObject({ attention: 4, read: 4 })
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
  it('converges early, late and reset viewers at ordered publication cursors', async () => {
    const s = await setup()
    await s.live.attach(s.laneId, 'pi').ready
    s.subscribe('early')
    await tick()
    const cursors: number[] = []
    s.live.streams.listen(s.laneId, (frame) => {
      if (!frame) return
      cursors.push(frame.cursor.seq)
      expect(s.snapshot().cursor).toEqual(frame.cursor)
      if (frame.event.kind === 'pi' && frame.event.push.kind === 'event')
        expect(s.snapshot().messages.at(-1)).toEqual({ role: 'user', content: 'hello' })
    })
    s.push({ type: 'message_end', message: { role: 'user', content: 'hello' } })
    s.subscribe('late')
    for (let n = 0; n < 5; n++) s.push({ type: 'queue_update', steering: [], followUp: [] })
    s.subscribe('reset', { epoch, seq: 0 })
    await tick()
    expect(cursors).toEqual(cursors.map((_, index) => cursors[0]! + index))
    for (const id of ['early', 'late', 'reset']) {
      const frames = s.frames.filter((frame) => 'id' in frame && frame.id === id)
      const initial = frames[0]
      if (initial?.type !== 'snapshot') throw new Error('missing snapshot')
      const messages = [...initial.snapshot.messages]
      for (const frame of frames) {
        if (
          frame.type === 'event' &&
          frame.event.kind === 'pi' &&
          frame.event.push.kind === 'event' &&
          frame.event.push.event.type === 'message_end'
        )
          messages.push(frame.event.push.event.message)
      }
      expect(messages).toEqual(s.snapshot().messages)
      expect(frames.at(-1)).toMatchObject(
        id === 'reset' ? { reset: true, snapshot: s.snapshot() } : { cursor: s.snapshot().cursor },
      )
    }
    const before = s.live.streams.cursor(s.laneId)
    s.live.push(s.laneId, { kind: 'stderr', text: 'private' })
    expect(s.live.streams.cursor(s.laneId)).toEqual(before)
    expect(JSON.stringify(s.frames)).not.toContain('private')
  })
  it('supersedes the old summary once when control changes during publication', async () => {
    const s = await setup()
    await s.live.attach(s.laneId, 'pi').ready
    const deltas: unknown[] = []
    s.live.lanesTopic.listen((frame) => {
      if (frame?.type === 'lanes-delta') deltas.push(frame.upsert)
    })
    let reentered = false
    s.live.streams.listen(s.laneId, (frame) => {
      if (frame?.event.kind !== 'summary' || reentered) return
      reentered = true
      const control = s.store.takeControl(s.laneId, {
        clientId: '12345678-1234-4234-8234-123456789012',
        label: 'new controller',
      })
      s.live.publish(s.laneId, { kind: 'control', control })
    })
    s.push({ type: 'agent_start' })
    expect(deltas).toEqual([[s.live.summaryFor(s.laneId)]])
    expect(s.live.summaryFor(s.laneId)?.control.controller?.label).toBe('new controller')
    const cursor = s.live.streams.cursor(s.laneId)
    s.push({ type: 'queue_update', steering: [], followUp: [] })
    expect(s.live.streams.cursor(s.laneId).seq).toBe(cursor.seq + 1)
    expect(deltas).toHaveLength(1)
  })
})
