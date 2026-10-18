// DM-18 frozen inventory: 38 cases; full original names recorded in the characterization commit.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRemoteLanes } from './remote-lanes'
import { createHostAttention } from './attention'
import { REMOTE_UNAVAILABLE, UNKNOWN_OUTCOME } from './lane-ops'
import { drain, setup } from './__fixtures__/remote-lanes'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('reconnects with after and resends the exact unanswered frame, then resets on an epoch change', async () => {
  const t = await setup(100)
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  await vi.advanceTimersByTimeAsync(100)
  t.frames.length = 0
  const result = t.lanes.command(1, info.sessionId, { type: 'prompt', message: 'Once' })
  await drain()
  const original = t.frames.find((f) => f.type === 'command' && f.op.type === 'prompt')
  t.pairs[0]?.client.close(1000, 'Drop')
  await drain()
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  expect(t.frames.filter((f) => f.type === 'command' && f.op.type === 'prompt')).toEqual([
    original,
    original,
  ])
  expect(await result).toMatchObject({ success: true })
  expect(
    t.frames.filter((f) => f.type === 'subscribe' && f.topic === 'lane').at(-1),
  ).toHaveProperty('after')
  const resyncs = t.pushes.filter(({ push }) => push.kind === 'resync').length
  t.host.restart()
  await drain()
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  expect(t.pushes.filter(({ push }) => push.kind === 'resync').length).toBeGreaterThan(resyncs)
  t.c.close()
  t.host.stop()
})

it('maps crash uncertainty without a fresh request id and expires unanswered commands at 60 seconds', async () => {
  const t = await setup(100)
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  await vi.advanceTimersByTimeAsync(100)
  const result = t.lanes.command(1, info.sessionId, { type: 'prompt', message: 'Uncertain' })
  await drain()
  t.host.restart()
  await drain()
  await vi.advanceTimersByTimeAsync(1000)
  await drain()
  expect(await result).toMatchObject({ success: false, error: UNKNOWN_OUTCOME })
  t.delivery.receipts = false
  const noAnswer = t.lanes.command(1, info.sessionId, { type: 'prompt', message: 'Lost' })
  await drain()
  let settled = false
  void noAnswer.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(59_999)
  await drain()
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await drain()
  expect(settled).toBe(true)
  expect(await noAnswer).toMatchObject({ success: false, error: UNKNOWN_OUTCOME })
  t.c.close()
  t.host.stop()
})

it('deduplicates attention and calls the notification port once with machine context and a click action', async () => {
  const t = await setup()
  t.host.openDialog(t.laneId)
  await drain()
  expect(t.notify).toHaveBeenCalledTimes(1)
  expect(t.publish).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: t.hostId, laneId: t.laneId, kind: 'needs-input' }),
  )
  const frame = t.c.attention()[0]
  if (!frame) throw new Error('Missing attention')
  t.attention.receive(t.hostId, frame.event)
  expect(t.notify).toHaveBeenCalledTimes(1)
  const notification = t.notify.mock.calls[0]
  expect(notification?.[0]).toBe('bee1 · Untitled lane')
  const click: unknown = notification?.[2]
  if (typeof click !== 'function') throw new Error('Missing click')
  click()
  expect(t.openRequested).toHaveBeenCalledWith(t.hostId, t.laneId)
  const read = t.lanes.action(t.hostId, t.laneId, 'lane.markRead')
  await drain()
  await read
  const lane = t.c.snapshot().lanes[0]
  expect(lane?.read).toBe(lane?.attention)
  t.c.close()
  t.host.stop()
})

it('fails closed on missing capabilities, missing lanes, and invalid creation fields', async () => {
  const t = await setup()
  await expect(t.lanes.open(t.window, randomUUID(), t.laneId)).rejects.toThrow(REMOTE_UNAVAILABLE)
  await expect(t.lanes.open(t.window, t.hostId, randomUUID())).rejects.toThrow('Lane unavailable')
  const before = t.frames.length
  await expect(
    t.lanes.create(t.window, t.hostId, {
      repositoryId: '0123456789abcdef',
      worktree: { branch: '../escape' },
    }),
  ).rejects.toThrow('Lane creation not confirmed.')
  expect(t.frames).toHaveLength(before)
  t.c.close()
  await expect(t.lanes.open(t.window, t.hostId, t.laneId)).rejects.toThrow(REMOTE_UNAVAILABLE)
  t.host.stop()
})

it('creates, stops and resumes a lane without writing a transcript or a local path', async () => {
  const t = await setup()
  const creation = t.lanes.create(t.window, t.hostId, {
    repositoryId: '0123456789abcdef',
    name: 'Remote',
  })
  await drain()
  const info = await creation
  expect(info.laneId).toBeDefined()
  if (!info.laneId) throw new Error('Missing id')
  const stop = t.lanes.action(t.hostId, info.laneId, 'lane.stop')
  await drain()
  await stop
  const resume = t.lanes.action(t.hostId, info.laneId, 'lane.resume')
  await drain()
  await resume
  expect(t.c.snapshot().lanes.find((l) => l.laneId === info.laneId)?.activity).toBe('idle')
  t.lanes.closeWindow(1)
  expect(t.lanes.list(1)).toEqual([])
  t.c.close()
  t.host.stop()
})

it('allows exactly 64 handles per window across Hosts and rejects the 65th before subscribing', async () => {
  const first = await setup()
  const second = await setup()
  const lanes = createRemoteLanes({
    connection: (id) =>
      id === first.hostId ? first.c : id === second.hostId ? second.c : undefined,
    present: () => true,
    label: () => 'Test',
    changed: () => {},
  })
  const ids = [first.laneId]
  for (let i = 1; i < 64; i++) {
    const creation = first.c.send({
      type: 'lane.create',
      repositoryId: '0123456789abcdef',
      worktree: null,
    })
    await drain()
    const receipt = await creation
    if (receipt.status !== 'done' || !receipt.laneId) throw new Error('No lane')
    ids.push(receipt.laneId)
  }
  for (const id of ids.slice(0, 63)) {
    const opening = lanes.open(first.window, first.hostId, id)
    await drain()
    await opening
  }
  const last = lanes.open(first.window, second.hostId, second.laneId)
  await drain()
  await last
  expect(lanes.list(1)).toHaveLength(64)
  const overflowId = ids[63]
  if (!overflowId) throw new Error('No overflow lane')
  const before = first.frames.length
  await expect(lanes.open(first.window, first.hostId, overflowId)).rejects.toThrow(
    'Too many open remote lanes',
  )
  expect(first.frames).toHaveLength(before)
  lanes.clear()
  first.c.close()
  first.host.stop()
  second.c.close()
  second.host.stop()
})

it('requires announced read/control capabilities instead of a preview flag', async () => {
  const t = await setup()
  const snapshot = t.c.snapshot()
  const spy = vi.spyOn(t.c, 'snapshot').mockReturnValue({ ...snapshot, capabilities: [] })
  await expect(t.lanes.open(t.window, t.hostId, t.laneId)).rejects.toThrow(REMOTE_UNAVAILABLE)
  spy.mockReturnValue({ ...snapshot, capabilities: ['sessions.read'] })
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  const denied = t.lanes.command(1, info.sessionId, { type: 'prompt', message: 'Denied' })
  await drain()
  expect(await denied).toMatchObject({ success: false, error: REMOTE_UNAVAILABLE })
  expect(await t.lanes.command(1, info.sessionId, { type: 'get_messages' })).toMatchObject({
    success: true,
  })
  t.lanes.clear()
  t.c.close()
  t.host.stop()
})

it('publishes focused attention without showing an OS notification', () => {
  const notify = vi.fn(),
    publish = vi.fn()
  const attention = createHostAttention({
    label: () => 'bee1',
    focused: () => true,
    notify,
    publish,
    open: vi.fn(),
  })
  attention.receive(randomUUID(), {
    id: 'once',
    laneId: randomUUID(),
    kind: 'routine-finished',
    attention: 1,
    at: new Date().toISOString(),
    title: null,
  })
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'routine', title: 'Untitled lane' }),
  )
  expect(notify).not.toHaveBeenCalled()
})

it('reports unknown at 60 seconds offline and asks status, never resending the op, on a later reconnect', async () => {
  const t = await setup(100)
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  await vi.advanceTimersByTimeAsync(100)
  const result = t.lanes.command(1, info.sessionId, { type: 'prompt', message: 'Delayed' })
  await drain()
  const original = t.frames.find((f) => f.type === 'command' && f.op.type === 'prompt')
  if (!original || original.type !== 'command') throw new Error('Missing command')
  t.delivery.available = false
  t.pairs[0]?.client.close(1000, 'Drop')
  await drain()
  await vi.advanceTimersByTimeAsync(60_000)
  await drain()
  expect(await result).toMatchObject({ success: false, error: UNKNOWN_OUTCOME })
  t.delivery.available = true
  await vi.advanceTimersByTimeAsync(60_000)
  await drain()
  expect(
    t.frames.filter((f) => f.type === 'command' && f.requestId === original.requestId),
  ).toHaveLength(1)
  expect(
    t.frames.some((f) => f.type === 'receipt-status' && f.requestId === original.requestId),
  ).toBe(true)
  t.lanes.clear()
  t.c.close()
  t.host.stop()
})

it.each(['workspaces.read', 'artifacts.read'] as const)(
  'resolves the focused lane and gates %s before and after calls',
  async (capability) => {
    const t = await setup()
    const opening = t.lanes.open(t.window, t.hostId, t.laneId)
    await drain()
    const info = await opening
    expect(() => t.lanes.readLane(1, info.workspacePath)).toThrow(REMOTE_UNAVAILABLE)
    t.lanes.setFocused(1, { hostId: t.hostId, laneId: t.laneId })
    expect(() => t.lanes.readLane(2, info.workspacePath)).toThrow(REMOTE_UNAVAILABLE)
    expect(() => t.lanes.readLane(1, info.workspacePath + 'x')).toThrow(REMOTE_UNAVAILABLE)
    const lane = t.lanes.readLane(
      1,
      capability === 'artifacts.read' ? info.sessionId : info.workspacePath,
    )
    if (!lane) throw new Error('Missing lane')
    const call = vi
      .spyOn(t.c, 'call')
      .mockResolvedValue({ type: 'result', id: randomUUID(), ok: true, data: { files: ['a'] } })
    await expect(
      lane.call(capability, capability === 'artifacts.read' ? 'artifacts.list' : 'files.list', {
        laneId: t.laneId,
      }),
    ).rejects.toThrow(REMOTE_UNAVAILABLE)
    expect(call).not.toHaveBeenCalled()
    const snapshot = t.c.snapshot()
    const view = vi.spyOn(t.c, 'snapshot').mockImplementation(() => ({
      ...snapshot,
      capabilities: ['sessions.read', 'workspaces.read', 'skills.read', 'artifacts.read'],
    }))
    expect(
      await lane.call(
        capability,
        capability === 'artifacts.read' ? 'artifacts.list' : 'files.list',
        { laneId: t.laneId },
      ),
    ).toEqual({
      files: ['a'],
    })
    call.mockImplementation(async () => {
      view.mockReturnValue({ ...snapshot, capabilities: ['sessions.read'] })
      return { type: 'result', id: randomUUID(), ok: true, data: { files: ['a'] } }
    })
    await expect(
      lane.call(capability, capability === 'artifacts.read' ? 'artifacts.list' : 'files.list', {
        laneId: t.laneId,
      }),
    ).rejects.toThrow(REMOTE_UNAVAILABLE)
    view.mockReturnValue({
      ...snapshot,
      capabilities: ['sessions.read', 'workspaces.read', 'skills.read', 'artifacts.read'],
    })
    call.mockResolvedValue({
      type: 'result',
      id: randomUUID(),
      ok: false,
      error: { code: 'internal', message: '/private output' },
    })
    await expect(
      lane.call(capability, capability === 'artifacts.read' ? 'artifacts.list' : 'files.list', {}),
    ).rejects.toThrow(REMOTE_UNAVAILABLE)
    call.mockResolvedValue({ type: 'result', id: randomUUID(), ok: true, data: { models: [] } })
    expect(
      await t.lanes.command(1, info.sessionId, { type: 'get_available_models' }),
    ).toMatchObject({
      success: true,
      data: { models: [] },
    })
    expect(call).toHaveBeenLastCalledWith('lane.models', { laneId: t.laneId })
    expect(call).not.toHaveBeenCalledWith('machine.models', expect.anything())
    call.mockImplementation(async () => {
      view.mockReturnValue({
        ...snapshot,
        state: 'reconnecting',
        capabilities: ['sessions.read', 'workspaces.read', 'artifacts.read'],
      })
      return { type: 'result', id: randomUUID(), ok: true, data: { files: ['a'] } }
    })
    await expect(
      lane.call(capability, capability === 'artifacts.read' ? 'artifacts.list' : 'files.list', {}),
    ).rejects.toThrow(REMOTE_UNAVAILABLE)
    view.mockReturnValue({
      ...snapshot,
      capabilities: ['sessions.read', 'workspaces.read', 'artifacts.read'],
    })
    call.mockImplementation(async () => {
      t.lanes.setFocused(1, null)
      return { type: 'result', id: randomUUID(), ok: true, data: { files: ['a'] } }
    })
    await expect(
      lane.call(capability, capability === 'artifacts.read' ? 'artifacts.list' : 'files.list', {}),
    ).rejects.toThrow(REMOTE_UNAVAILABLE)
    t.lanes.setFocused(1, { hostId: t.hostId, laneId: t.laneId })
    call.mockImplementation(async () => {
      t.connection.mockReturnValue(undefined)
      return { type: 'result', id: randomUUID(), ok: true, data: { files: ['a'] } }
    })
    await expect(
      lane.call(capability, capability === 'artifacts.read' ? 'artifacts.list' : 'files.list', {}),
    ).rejects.toThrow(REMOTE_UNAVAILABLE)
    t.connection.mockReturnValue(t.c)
    call.mockImplementation(async () => {
      t.lanes.dispose(1, info.sessionId)
      const reopening = t.lanes.open(t.window, t.hostId, t.laneId)
      await drain()
      await reopening
      t.lanes.setFocused(1, { hostId: t.hostId, laneId: t.laneId })
      return { type: 'result', id: randomUUID(), ok: true, data: { files: ['a'] } }
    })
    await expect(
      lane.call(capability, capability === 'artifacts.read' ? 'artifacts.list' : 'files.list', {}),
    ).rejects.toThrow(REMOTE_UNAVAILABLE)
    t.lanes.clear()
    t.c.close()
  },
)
