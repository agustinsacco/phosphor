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

it('routes prompts and queries, names rejecting controllers, and publishes takeover before the next prompt', async () => {
  const t = await setup()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  const response = t.lanes.command(1, info.sessionId, {
    type: 'prompt',
    message: 'Test',
    id: 'rpc-id',
  })
  await drain()
  expect(await response).toMatchObject({ success: true, id: 'rpc-id' })
  const query = t.lanes.command(1, info.sessionId, { type: 'get_available_models' })
  await drain()
  expect(await query).toMatchObject({ success: true })
  const second = t.connect('second')
  await drain()
  const take = second.send({ type: 'control.take' }, t.laneId)
  await drain()
  await take
  expect(t.c.snapshot().lanes[0]?.control.controller?.label).toBe('Other Desktop')
  const rejected = t.lanes.command(1, info.sessionId, { type: 'abort' })
  await drain()
  expect(await rejected).toMatchObject({
    success: false,
    error: 'bee1: controlled by Other Desktop',
  })
  const retake = t.lanes.action(t.hostId, t.laneId, 'control.take')
  await drain()
  await retake
  expect(t.c.snapshot().lanes[0]?.control.controller?.label).toBe('Desktop')
  const prompt = t.lanes.command(1, info.sessionId, { type: 'prompt', message: 'Next' })
  await drain()
  expect(await prompt).toMatchObject({ success: true })
  expect(await t.lanes.command(1, info.sessionId, { type: 'bash', command: 'no' })).toMatchObject({
    success: false,
    error: REMOTE_UNAVAILABLE,
  })
  const answer = t.lanes.respond(1, info.sessionId, {
    type: 'extension_ui_response',
    id: 'missing',
    confirmed: true,
  })
  const rejection = expect(answer).rejects.toThrow()
  await drain()
  await rejection
  t.host.openDialog(t.laneId, 'answerable')
  await drain()
  const accepted = t.lanes.respond(1, info.sessionId, {
    type: 'extension_ui_response',
    id: 'answerable',
    confirmed: true,
  })
  await drain()
  await accepted
  const stats = t.lanes.command(1, info.sessionId, { type: 'get_session_stats' })
  await drain()
  expect(await stats).toMatchObject({ success: true, data: { sessionId: info.sessionId } })
  second.close()
  t.c.close()
  t.host.stop()
})

it.each(['files', 'attachments'] as const)(
  'routes %s with the current fence and rechecks capabilities, focus and handles',
  async (kind) => {
    const t = await setup()
    const opening = t.lanes.open(t.window, t.hostId, t.laneId)
    await drain()
    const info = await opening
    t.lanes.setFocused(1, { hostId: t.hostId, laneId: t.laneId })
    const lane = t.lanes.readLane(1, info.workspacePath)
    if (!lane) throw new Error('Missing lane')
    const op =
      kind === 'files'
        ? { type: 'files.create' as const, path: 'a', kind: 'file' as const }
        : { type: 'attachments.begin' as const, name: 'a.pdf', size: 1, mime: 'application/pdf' }
    const send = vi
      .spyOn(t.c, 'send')
      .mockResolvedValue({ requestId: randomUUID(), status: 'done' })
    const snapshot = t.c.snapshot()
    const view = vi.spyOn(t.c, 'snapshot').mockReturnValue(snapshot)
    await expect(lane.write(op)).rejects.toThrow(REMOTE_UNAVAILABLE)
    expect(send).not.toHaveBeenCalled()
    const writable = {
      ...snapshot,
      capabilities: ['sessions.read', 'sessions.control', 'workspaces.write'] as const,
    }
    view.mockReturnValue({ ...writable, capabilities: [...writable.capabilities] })
    await expect(lane.write(op)).resolves.toBeUndefined()
    expect(send).toHaveBeenLastCalledWith(
      op,
      t.laneId,
      snapshot.lanes.find((l) => l.laneId === t.laneId)?.control.fence,
    )
    send.mockResolvedValue({ requestId: randomUUID(), status: 'rejected', code: 'conflict' })
    await expect(lane.write(op)).rejects.toThrow('changed-on-disk')
    send.mockResolvedValue({ requestId: randomUUID(), status: 'unknown' })
    await expect(lane.write(op)).rejects.toThrow('File mutation not confirmed')
    send.mockImplementation(async () => {
      view.mockReturnValue(snapshot)
      return { requestId: randomUUID(), status: 'done' }
    })
    await expect(lane.write(op)).rejects.toThrow(REMOTE_UNAVAILABLE)
    view.mockReturnValue({ ...writable, capabilities: [...writable.capabilities] })
    send.mockImplementation(async () => {
      t.lanes.setFocused(1, null)
      return { requestId: randomUUID(), status: 'done' }
    })
    await expect(lane.write(op)).rejects.toThrow(REMOTE_UNAVAILABLE)
    t.lanes.setFocused(1, { hostId: t.hostId, laneId: t.laneId })
    send.mockImplementation(async () => {
      view.mockReturnValue({ ...writable, capabilities: [...writable.capabilities], lanes: [] })
      return { requestId: randomUUID(), status: 'done' }
    })
    await expect(lane.write(op)).rejects.toThrow(REMOTE_UNAVAILABLE)
    view.mockReturnValue({ ...writable, capabilities: [...writable.capabilities] })
    send.mockImplementation(async () => {
      t.connection.mockReturnValue(undefined)
      return { requestId: randomUUID(), status: 'done' }
    })
    await expect(lane.write(op)).rejects.toThrow(REMOTE_UNAVAILABLE)
    t.connection.mockReturnValue(t.c)
    send.mockImplementation(async () => {
      t.lanes.dispose(1, info.sessionId)
      return { requestId: randomUUID(), status: 'done' }
    })
    await expect(lane.write(op)).rejects.toThrow(REMOTE_UNAVAILABLE)
    t.lanes.clear()
    t.c.close()
    t.host.stop()
  },
)

it.each(['replacement', 'removal', 'dispose'] as const)(
  'terminal handle is invalidated by %s',
  async (reason) => {
    const t = await setup()
    const opening = t.lanes.open(t.window, t.hostId, t.laneId)
    await drain()
    const info = await opening
    const lane = t.lanes.terminalLane(1, info.sessionId, info.workspacePath)
    expect(lane.current()).toBe(true)
    if (reason === 'replacement') {
      const replacement = t.connect('first')
      await drain()
      t.connection.mockReturnValue(replacement)
      t.lanes.reconcile()
      expect(lane.current()).toBe(false)
      replacement.close()
    } else if (reason === 'removal') {
      const snapshot = t.c.snapshot()
      vi.spyOn(t.c, 'snapshot').mockReturnValue({ ...snapshot, lanes: [] })
      expect(lane.current()).toBe(false)
    } else {
      t.lanes.dispose(1, info.sessionId)
      expect(lane.current()).toBe(false)
    }
    t.lanes.clear()
    t.c.close()
  },
)

it('preflights remote image frames in main before send, accepting just under the margin', async () => {
  const t = await setup()
  const opening = t.lanes.open(t.window, t.hostId, t.laneId)
  await drain()
  const info = await opening
  const send = vi.spyOn(t.c, 'send').mockResolvedValue({ requestId: randomUUID(), status: 'done' })
  const message = 'é'.repeat(32)
  const op = {
    type: 'prompt' as const,
    message,
    images: [{ type: 'image' as const, mimeType: 'image/png', data: '' }],
  }
  const overhead = Buffer.byteLength(
    JSON.stringify({
      type: 'command',
      requestId: randomUUID(),
      laneId: t.laneId,
      fence: 1,
      trace: 'a'.repeat(16),
      op,
    }),
  )
  const size = HOST_LIMITS.inboundFrameBytes - 1024 - overhead
  op.images[0]!.data = 'A'.repeat(size + 4)
  const before = t.frames.length
  expect(await t.lanes.command(1, info.sessionId, op)).toMatchObject({
    success: false,
    error: 'Image too large for a remote lane.',
  })
  expect(send).not.toHaveBeenCalled()
  expect(t.frames).toHaveLength(before)
  op.images[0]!.data = 'A'.repeat(size - 4)
  expect(await t.lanes.command(1, info.sessionId, op)).toMatchObject({ success: true })
  expect(send).toHaveBeenCalledOnce()
  t.lanes.dispose(1, info.sessionId)
  t.c.close()
})

it.each(['connection', 'handle', 'focus'] as const)(
  'refuses attachment write before any frame when its %s changes',
  async (changed) => {
    const t = await setup()
    const opening = t.lanes.open(t.window, t.hostId, t.laneId)
    await drain()
    const info = await opening
    t.lanes.setFocused(1, { hostId: t.hostId, laneId: t.laneId })
    const lane = t.lanes.readLane(1, info.sessionId)
    if (!lane) throw new Error('Missing lane')
    const writable = {
      ...t.c.snapshot(),
      capabilities: ['sessions.read', 'sessions.control', 'workspaces.write'] as const,
    }
    vi.spyOn(t.c, 'snapshot').mockReturnValue({
      ...writable,
      capabilities: [...writable.capabilities],
    })
    const replacement = changed === 'connection' ? t.connect('first') : t.c
    await drain()
    if (replacement !== t.c) {
      vi.spyOn(replacement, 'snapshot').mockReturnValue({
        ...writable,
        capabilities: [...writable.capabilities],
      })
      t.connection.mockReturnValue(replacement)
    }
    if (changed === 'handle') t.lanes.dispose(1, info.sessionId)
    if (changed === 'focus') t.lanes.setFocused(1, null)
    const send = vi
      .spyOn(replacement, 'send')
      .mockResolvedValue({ requestId: randomUUID(), status: 'done' })
    await expect(
      lane.write({ type: 'attachments.begin', name: 'a.pdf', size: 0, mime: '' }),
    ).rejects.toThrow(REMOTE_UNAVAILABLE)
    expect(send).not.toHaveBeenCalled()
    t.lanes.clear()
    replacement.close()
    t.c.close()
    t.host.stop()
  },
)

it.each(['incarnation', 'focus-cycle', 'removed-lane'] as const)(
  'rejects a completed file read after %s changes',
  async (change) => {
    const t = await setup()
    const opening = t.lanes.open(t.window, t.hostId, t.laneId)
    await drain()
    const info = await opening
    t.lanes.setFocused(1, { hostId: t.hostId, laneId: t.laneId })
    const lane = t.lanes.readLane(1, info.workspacePath)
    if (!lane) throw new Error('fixture')
    const snapshot = t.c.snapshot()
    const view = vi
      .spyOn(t.c, 'snapshot')
      .mockReturnValue({ ...snapshot, capabilities: ['sessions.read', 'workspaces.read'] })
    const initial = t.c.incarnation()
    const incarnation = vi.spyOn(t.c, 'incarnation').mockReturnValue(initial)
    vi.spyOn(t.c, 'call').mockImplementation(async () => {
      if (change === 'incarnation')
        incarnation.mockReturnValue({ ...initial, generation: initial.generation + 1 })
      if (change === 'focus-cycle') {
        t.lanes.setFocused(1, null)
        t.lanes.setFocused(1, { hostId: t.hostId, laneId: t.laneId })
      }
      if (change === 'removed-lane')
        view.mockReturnValue({
          ...snapshot,
          capabilities: ['sessions.read', 'workspaces.read'],
          lanes: [],
        })
      return { type: 'result', id: randomUUID(), ok: true, data: { files: ['a'] } }
    })
    await expect(lane.call('workspaces.read', 'files.list', { laneId: t.laneId })).rejects.toThrow(
      REMOTE_UNAVAILABLE,
    )
    t.lanes.clear()
    t.c.close()
    t.host.stop()
  },
)

it.each(['branch-exists', 'forbidden'] as const)(
  'creation passes only the fixed fresh refusal code: %s',
  async (code) => {
    const t = await setup()
    vi.spyOn(t.c, 'send').mockResolvedValue({ requestId: randomUUID(), status: 'rejected', code })
    await expect(
      t.lanes.create(t.window, t.hostId, {
        repositoryId: '0123456789abcdef',
        worktree: { branch: 'fresh', fresh: true },
      }),
    ).rejects.toThrow(code === 'branch-exists' ? 'branch-exists' : 'Lane creation not confirmed.')
    t.c.close()
    t.host.stop()
  },
)

it.each(['failed', 'transport'] as const)(
  'never authorizes a retry from a %s error message',
  async (mode) => {
    const t = await setup()
    const send = vi.spyOn(t.c, 'send')
    if (mode === 'failed')
      send.mockResolvedValue({
        requestId: randomUUID(),
        status: 'failed',
        error: { code: 'internal', message: 'branch-exists' },
      })
    else send.mockRejectedValue(new Error('branch-exists'))
    await expect(
      t.lanes.create(t.window, t.hostId, {
        repositoryId: '0123456789abcdef',
        worktree: { branch: 'fresh', fresh: true },
      }),
    ).rejects.toThrow('Lane creation not confirmed.')
    t.c.close()
    t.host.stop()
  },
)
