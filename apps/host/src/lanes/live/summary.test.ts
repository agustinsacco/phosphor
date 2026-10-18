import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseHostFrame, type HostFrame } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import type { PiEvent, RpcCommand, RpcResponse, RpcSessionState } from '@phosphor/shared/rpc'
import { openStore } from '../store'
import { createLiveLanes } from '../live'
import { promptTitle } from './summary'
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
describe('live summary metadata', () => {
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
  it('limits prompt titles by UTF-16 units without splitting Unicode code points', () => {
    expect(promptTitle(' \n  hello   world \nignored')).toBe('hello world')
    expect(promptTitle('x'.repeat(80))).toBe('x'.repeat(80))
    expect(promptTitle('😀'.repeat(40))).toBe('😀'.repeat(40))
    expect(promptTitle('😀'.repeat(41))).toBe('😀'.repeat(39) + '…')
    expect(promptTitle('x'.repeat(78) + '😀tail')).toBe('x'.repeat(78) + '…')
    expect(promptTitle('  \n  ')).toBeNull()
    expect(promptTitle('hidden\u202etext')).toBeNull()
    expect(promptTitle('bad\u0001text')).toBeNull()
  })
  it('uses the first textual user prompt only when live and stored titles are absent', async () => {
    const s = await setup()
    await s.live.attach(s.laneId, 'pi').ready
    s.push({
      type: 'message_end',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: ' First   prompt ' },
          { type: 'text', text: 'ignored line' },
        ],
      },
    })
    expect(s.live.summaryFor(s.laneId)?.title).toBe('First prompt')
    s.live.firstPrompt(s.laneId, ' Explicit   prompt ')
    s.live.firstPrompt(s.laneId, 'ignored second prompt')
    expect(s.live.summaryFor(s.laneId)?.title).toBe('Explicit prompt')
    s.store.updateLane(s.laneId, { title: 'stored' })
    expect(s.live.summaryFor(s.laneId)?.title).toBe('stored')
    s.store.markRemoved(s.laneId)
    expect(s.live.summaryFor(s.laneId)).toBeNull()
    expect(s.live.summaryFor('12345678-1234-4234-8234-123456789012')).toBeNull()
  })
})
