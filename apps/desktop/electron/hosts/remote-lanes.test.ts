import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFakeHost, createLoopbackPair } from '@shared/host-protocol-testing'
import {
  HOST_LIMITS,
  parseClientFrame,
  parseHostFrame,
  type ClientFrame,
} from '@shared/host-protocol'
import type { GrantPayload } from '@shared/host-grant'
import type { SessionPush } from '@shared/models'
import { createHostConnection } from './connection'
import { createRemoteLanes } from './remote-lanes'
import { createHostAttention } from './attention'
import { REMOTE_UNAVAILABLE, UNKNOWN_OUTCOME } from './lane-ops'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
async function drain() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

async function setup(delay = 0) {
  const keys = generateKeyPairSync('ed25519')
  const hostId = randomUUID()
  const claims: GrantPayload = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId,
    epoch: 1,
    client: { id: randomUUID(), label: 'Desktop' },
    caps: ['sessions.read', 'sessions.control'],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: randomBytes(8).toString('hex'),
  }
  const host = createFakeHost({
    expectations: { iss: claims.iss, hostId, owner: claims.sub, epoch: 1 },
    id: randomUUID,
    epoch: () => randomBytes(8).toString('hex'),
    verify: () => true,
    verifyGrant: (token) => ({
      ...claims,
      client: token === 'second' ? { id: secondId, label: 'Other Desktop' } : claims.client,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
    sign: (bytes) => sign(null, bytes, keys.privateKey),
    commandDelayMs: delay,
  })
  const secondId = randomUUID()
  const frames: ClientFrame[] = []
  const pairs: ReturnType<typeof createLoopbackPair>[] = []
  const exported = keys.publicKey.export({ format: 'jwk' }).x
  if (!exported) throw new Error('Missing test key')
  const publicKey: string = exported
  const delivery = { receipts: true, available: true }
  const notify = vi.fn()
  const publish = vi.fn()
  const openRequested = vi.fn()
  const pushes: { channel: string; push: SessionPush }[] = []
  const window = {
    id: 1,
    send: (channel: string, push: SessionPush) => pushes.push({ channel, push }),
    destroyed: () => false,
  }
  const attention = createHostAttention({
    label: () => 'bee1',
    focused: () => false,
    notify,
    publish,
    open: openRequested,
  })
  function connect(token: string) {
    return createHostConnection({
      hostId,
      endpoint: 'https://bee.tail.ts.net:47615',
      socket: async () => {
        if (!delivery.available) throw new Error('Offline test transport')
        const pair = createLoopbackPair()
        pairs.push(pair)
        pair.server.onMessage((text) => {
          const p = parseClientFrame(text)
          if (p.ok) frames.push(p.frame)
        })
        host.attach(pair.server)
        return {
          ...pair.client,
          onMessage: (cb: (text: string) => void) =>
            pair.client.onMessage((text) => {
              const frame = parseHostFrame(text)
              if (!delivery.receipts && frame.ok && frame.value.type === 'receipt') return
              cb(text)
            }),
        }
      },
      grant: async () => ({
        grant: token,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        host: { id: hostId, publicKey, endpoint: 'https://bee.tail.ts.net:47615' },
      }),
      clearGrant: () => {},
      changed: () => {},
      random: () => 1,
      onAttention: (event) => attention.receive(hostId, event),
    })
  }
  const c = connect('first')
  const lanes = createRemoteLanes({
    connection: (id) => (id === hostId ? c : undefined),
    present: (id) => id === hostId,
    label: () => 'bee1',
    changed: vi.fn(),
  })
  await drain()
  const creation = c.send({ type: 'lane.create', repositoryId: '0123456789abcdef', worktree: null })
  await drain()
  if (delay) await vi.advanceTimersByTimeAsync(delay)
  await drain()
  const created = await creation
  if (created.status !== 'done' || !created.laneId) throw new Error('No test lane')
  return {
    c,
    delivery,
    lanes,
    host,
    hostId,
    laneId: created.laneId,
    window,
    frames,
    pairs,
    pushes,
    connect,
    attention,
    notify,
    publish,
    openRequested,
  }
}

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
  expect(info.workspacePath).toBe(`host:${t.hostId}/0123456789abcdef`)
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
  const state = await t.lanes.command(1, info.sessionId, { type: 'get_state' })
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
  expect(notification?.[0]).toBe('bee1')
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
  ).rejects.toThrow('Invalid remote lane request')
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
