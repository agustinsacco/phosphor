import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@shared/host-protocol'
import { REMOTE_UNAVAILABLE } from './lane-ops'
import { drain, setup } from './__fixtures__/remote-lanes'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('opens one window-owned opaque handle, hydrates in memory, and streams pi unchanged', async () => {
  const t = await setup()
  t.host.emitTurn(t.laneId)
  t.host.openDialog(t.laneId)
  t.host.emitUi(t.laneId, {
    type: 'extension_ui_request',
    method: 'setStatus',
    id: 'status',
    statusKey: 'phosphor-test',
    statusText: 'Ready',
  })
  await drain()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  expect(info.sessionId).toMatch(/^remote-[0-9a-f]{16}$/)
  expect(info.workspacePath).toBe(`host:${t.hostId}/lane:${t.laneId}`)
  expect(info.target).toEqual({ kind: 'remote', hostId: t.hostId })
  expect(info.diskPath).toBeUndefined()
  expect(await t.lanes.open(t.window, t.hostId, t.laneId)).toEqual(info)
  expect(t.frames.filter((f) => f.type === 'subscribe' && f.topic === 'lane')).toHaveLength(1)
  expect(t.pushes.some(({ push }) => push.kind === 'resync')).toBe(true)
  await t.lanes.command(1, info.sessionId, { type: 'get_messages' })
  await drain()
  expect(
    t.pushes.some(({ push }) => push.kind === 'extension-ui' && push.request.method === 'confirm'),
  ).toBe(true)
  // get_state asks the Host (lane.state); the Host answers asynchronously.
  const stating = t.lanes.command(1, info.sessionId, { type: 'get_state' })
  await drain()
  const state = await stating
  expect(state.success && state.data).not.toHaveProperty('sessionFile')
  const history = await t.lanes.command(1, info.sessionId, { type: 'get_messages' })
  expect(history.success && history.data).toHaveProperty('messages')
  const before = t.pushes.length
  t.host.emitTurn(t.laneId)
  await drain()
  expect(
    t.pushes
      .slice(before)
      .some(
        ({ channel, push }) => channel === `pi:event:${info.sessionId}` && push.kind === 'event',
      ),
  ).toBe(true)
  expect(t.lanes.list(2)).toEqual([])
  await expect(t.lanes.command(2, info.sessionId, { type: 'get_messages' })).rejects.toThrow(
    REMOTE_UNAVAILABLE,
  )
  t.lanes.dispose(1, info.sessionId)
  expect(t.lanes.list(1)).toEqual([])
  await expect(t.lanes.command(1, info.sessionId, { type: 'abort' })).rejects.toThrow(
    REMOTE_UNAVAILABLE,
  )
  t.c.close()
  t.host.stop()
})

it('keeps hydration frozen, then reads fresh Host thinking and name state', async () => {
  const t = await setup()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  const call = vi.spyOn(t.c, 'call')
  const frozen = await t.lanes.command(1, info.sessionId, { type: 'get_state' })
  const change = t.lanes.command(1, info.sessionId, {
    type: 'set_thinking_level',
    level: 'high',
  })
  await drain()
  expect(await change).toMatchObject({ success: true })
  expect(await t.lanes.command(1, info.sessionId, { type: 'get_state' })).toEqual(frozen)
  expect(call).not.toHaveBeenCalled()
  await t.lanes.command(1, info.sessionId, { type: 'get_messages' })
  expect(await t.lanes.command(1, info.sessionId, { type: 'get_state' })).toEqual(frozen)
  expect(call).not.toHaveBeenCalled()
  await drain()
  const fresh = t.lanes.command(1, info.sessionId, { type: 'get_state' })
  await drain()
  expect(await fresh).toMatchObject({
    success: true,
    data: { sessionId: info.sessionId, thinkingLevel: 'high' },
  })
  expect(call).toHaveBeenCalledWith('lane.state', { laneId: t.laneId })
  const rename = t.lanes.command(1, info.sessionId, {
    type: 'set_session_name',
    name: 'New title',
  })
  await drain()
  expect(await rename).toMatchObject({ success: true })
  const named = t.lanes.command(1, info.sessionId, { type: 'get_state' })
  await drain()
  expect(await named).toMatchObject({ success: true, data: { sessionName: 'New title' } })
  t.c.close()
  t.host.stop()
})

it('returns Host model state without its path or session identity', async () => {
  const t = await setup()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  await t.lanes.command(1, info.sessionId, { type: 'get_messages' })
  await drain()
  const change = t.lanes.command(1, info.sessionId, {
    type: 'set_model',
    provider: 'test-provider',
    modelId: 'new-model',
  })
  await drain()
  expect(await change).toMatchObject({ success: true })
  // The fake Host omits model metadata from state; supply the Host query response.
  vi.spyOn(t.c, 'call').mockResolvedValue({
    type: 'result',
    id: randomUUID(),
    ok: true,
    data: {
      sessionId: t.laneId,
      sessionFile: '/host/private/session.jsonl',
      model: { provider: 'test-provider', id: 'new-model', name: 'New model' },
      thinkingLevel: 'high',
    },
  })
  const state = await t.lanes.command(1, info.sessionId, { type: 'get_state' })
  expect(state).toMatchObject({
    success: true,
    data: {
      sessionId: info.sessionId,
      model: { provider: 'test-provider', id: 'new-model', name: 'New model' },
      thinkingLevel: 'high',
    },
  })
  expect(state.success && state.data).not.toHaveProperty('sessionFile')
  // A stopped/failed lane has no live lane.state. Keep this handle's last
  // confirmed model, rather than reverting to its pre-switch snapshot model.
  vi.mocked(t.c.call).mockResolvedValue({ type: 'result', id: randomUUID(), ok: true, data: null })
  expect(await t.lanes.command(1, info.sessionId, { type: 'get_state' })).toMatchObject({
    success: true,
    data: { model: { provider: 'test-provider', id: 'new-model', name: 'New model' } },
  })
  const changing = t.lanes.command(1, info.sessionId, {
    type: 'set_model',
    provider: 'other-provider',
    modelId: 'other-model',
  })
  await drain()
  expect(await changing).toMatchObject({ success: true })
  const missingMetadata = await t.lanes.command(1, info.sessionId, { type: 'get_state' })
  expect(missingMetadata.success && missingMetadata.data).toHaveProperty('model', undefined)
  t.c.close()
  t.host.stop()
})

it('falls back to projected state when the Host state is stopped or unavailable', async () => {
  const t = await setup()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  const frozen = await t.lanes.command(1, info.sessionId, { type: 'get_state' })
  await t.lanes.command(1, info.sessionId, { type: 'get_messages' })
  await drain()
  const call = vi.spyOn(t.c, 'call')
  call.mockResolvedValueOnce({ type: 'result', id: randomUUID(), ok: true, data: null })
  expect(await t.lanes.command(1, info.sessionId, { type: 'get_state' })).toEqual(frozen)
  call.mockResolvedValueOnce({
    type: 'result',
    id: randomUUID(),
    ok: false,
    error: { code: 'internal', message: 'Query failed.' },
  })
  expect(await t.lanes.command(1, info.sessionId, { type: 'get_state' })).toEqual(frozen)
  call.mockRejectedValueOnce(new Error('Transport unavailable.'))
  expect(await t.lanes.command(1, info.sessionId, { type: 'get_state' })).toEqual(frozen)
  t.c.close()
  t.host.stop()
})

it('holds live pushes during resync and flushes each once after snapshot history', async () => {
  const t = await setup()
  t.host.emitTurn(t.laneId)
  t.host.openDialog(t.laneId)
  await drain()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  t.host.emitTurn(t.laneId)
  await drain()
  expect(t.pushes.map(({ push }) => push.kind)).toEqual(['resync'])
  const history = await t.lanes.command(1, info.sessionId, { type: 'get_messages' })
  expect(history.success && history.data).toMatchObject({ messages: expect.any(Array) })
  expect(t.pushes.map(({ push }) => push.kind)).toEqual(['resync'])
  await drain()
  const kinds = t.pushes.map(({ push }) => push.kind)
  expect(kinds[1]).toBe('extension-ui')
  const end = t.pushes.filter(
    ({ push }) => push.kind === 'event' && push.event.type === 'message_end',
  )
  // emitTurn produces exactly one assistant message. Snapshot history is not replayed.
  expect(end).toHaveLength(1)
  t.lanes.setFocused(1, { hostId: t.hostId, laneId: t.laneId })
  expect(t.lanes.focused(t.hostId, t.laneId, 1)).toBe(true)
  t.lanes.setFocused(1, null)
  expect(t.lanes.focused(t.hostId, t.laneId, 1)).toBe(false)
  expect(() => t.lanes.setFocused(2, { hostId: t.hostId, laneId: t.laneId })).toThrow()
  t.lanes.clear()
  t.c.close()
  t.host.stop()
})

it('flushes held events after ten seconds when no renderer hydrate arrives', async () => {
  const t = await setup()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  await opening
  t.host.emitTurn(t.laneId)
  await drain()
  expect(t.pushes).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(9999)
  expect(t.pushes).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(t.pushes.length).toBeGreaterThan(1)
  t.lanes.clear()
  t.c.close()
  t.host.stop()
})

it('restarts hydration on held-event overflow instead of growing an unbounded queue', async () => {
  const t = await setup()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  await opening
  const status = {
    type: 'extension_ui_request' as const,
    method: 'setStatus' as const,
    id: 'held',
    statusKey: 'phosphor-held',
    statusText: 'Ready',
  }
  for (let i = 0; i < HOST_LIMITS.pendingEvents; i++) t.host.emitUi(t.laneId, status)
  await drain()
  expect(t.pushes.map(({ push }) => push.kind)).toEqual(['resync'])
  t.host.emitUi(t.laneId, status)
  await drain()
  expect(t.pushes.map(({ push }) => push.kind)).toEqual(['resync', 'resync'])
  t.lanes.clear()
  t.c.close()
  t.host.stop()
})

it('isolates malformed pi payloads accepted by the shallow protocol parser without touching local pi', async () => {
  const t = await setup()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  const subscription = t.frames.find((f) => f.type === 'subscribe' && f.topic === 'lane')
  const cursor = t.c.snapshot().cursor
  if (!subscription || !cursor) throw new Error('Missing subscription')
  t.pairs[0]?.server.send(
    JSON.stringify({
      type: 'event',
      id: subscription.id,
      laneId: t.laneId,
      cursor: { epoch: cursor.epoch, seq: 1 },
      event: { kind: 'pi', push: { kind: 'event', event: { type: 'message_end' } } },
    }),
  )
  await drain()
  expect(t.lanes.list(1)).toEqual([])
  expect(t.pushes.some(({ push }) => push.kind === 'exit' && !push.expected)).toBe(true)
  await expect(t.lanes.command(1, info.sessionId, { type: 'abort' })).rejects.toThrow(
    REMOTE_UNAVAILABLE,
  )
  t.c.close()
  t.host.stop()
})

it('holds exactly replayBytes and resyncs one byte past the hold byte limit', async () => {
  const t = await setup()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  await opening
  const request = {
    type: 'extension_ui_request' as const,
    method: 'notify' as const,
    id: 'held-bytes',
    level: 'info' as const,
    message: '',
  }
  const overhead = Buffer.byteLength(JSON.stringify({ kind: 'extension-ui', request }))
  const firstBytes = Math.floor(HOST_LIMITS.replayBytes / 2)
  t.host.emitUi(t.laneId, { ...request, message: 'x'.repeat(firstBytes - overhead) })
  await drain()
  t.host.emitUi(t.laneId, {
    ...request,
    message: 'x'.repeat(HOST_LIMITS.replayBytes - firstBytes - overhead),
  })
  await drain()
  expect(t.pushes.map(({ push }) => push.kind)).toEqual(['resync'])
  // A new epoch gives a fresh hold. Fill it to precisely one byte over the cap.
  t.host.restart()
  await drain()
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  expect(t.pushes.map(({ push }) => push.kind)).toEqual(['resync', 'resync'])
  t.host.emitUi(t.laneId, { ...request, message: 'x'.repeat(firstBytes - overhead) })
  await drain()
  t.host.emitUi(t.laneId, {
    ...request,
    message: 'x'.repeat(HOST_LIMITS.replayBytes - firstBytes - overhead + 1),
  })
  await drain()
  expect(t.pushes.map(({ push }) => push.kind)).toEqual(['resync', 'resync', 'resync'])
  t.lanes.clear()
  t.c.close()
  t.host.stop()
})

it('does not broadcast Host changes for ten pi text deltas but preserves summary changes', async () => {
  const t = await setup()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  await opening
  t.changed.mockClear()
  for (let i = 0; i < 10; i++) {
    t.host.emitUi(t.laneId, {
      type: 'extension_ui_request',
      method: 'setStatus',
      id: `s${i}`,
      statusKey: 'test-delta',
      statusText: 'stream',
    })
  }
  await drain()
  expect(t.changed).not.toHaveBeenCalled()
  t.host.emitTurn(t.laneId)
  await drain()
  expect(t.changed).toHaveBeenCalled()
})
