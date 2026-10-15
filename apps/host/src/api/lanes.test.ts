import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeGrant, type GrantPayload } from '@phosphor/shared/host-grant'
import {
  HOST_LIMITS,
  parseHostFrame,
  type HostFrame,
  type Receipt,
} from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import { parseRoutineOp, routineRequiresControl } from '@phosphor/shared/host-protocol-routines'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { LaneService, CallOutcome } from '../lanes/service'
import { createLaneStreams, createLanesTopic } from '../lanes/stream'
import { createAuthority } from './authority'
import { createConnection } from './connection'
import { createLaneAdapter } from './lanes'

function fixture(limits: Parameters<typeof createLaneAdapter>[1] = {}) {
  const control = generateKeyPairSync('ed25519')
  const host = generateKeyPairSync('ed25519')
  const epoch = '0123456789abcdef'
  const claims: GrantPayload = {
    v: 1,
    iss: 'http://localhost:12345',
    kid: 'test',
    sub: randomUUID(),
    sid: randomUUID(),
    hostId: randomUUID(),
    epoch: 1,
    client: { id: randomUUID(), label: 'Viewer' },
    caps: ['sessions.read', 'sessions.control'],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: epoch,
  }
  const authority = createAuthority()
  authority.accept({ accepted: true, nextInSec: 30, ownerId: claims.sub, epoch: 1 })
  const records = new Map<string, { clientId: string; op: string; receipt: Receipt }>()
  const service: LaneService = {
    epoch,
    capabilities: ['sessions.read', 'sessions.control'],
    streams: createLaneStreams({ epoch, snapshot: () => null }),
    lanesTopic: createLanesTopic({ epoch, list: () => ({ lanes: [], repositories: [] }) }),
    controllerPresence: vi.fn(),
    calls: {
      capabilityFor: () => 'sessions.read',
      call: vi.fn(async (): Promise<CallOutcome> => ({ ok: true, data: null })),
    },
    commands: {
      submit: vi.fn(async (client, frame) => {
        const connectionId =
          'connectionId' in client && typeof client.connectionId === 'string'
            ? client.connectionId
            : undefined
        const old = records.get(frame.requestId)
        if (old && (old.clientId !== client.id || old.op !== JSON.stringify(frame.op)))
          adapter.deliver(
            client.id,
            { requestId: frame.requestId, status: 'rejected', code: 'conflict' },
            connectionId,
          )
        else if (old) adapter.deliver(client.id, old.receipt, connectionId)
        else
          records.set(frame.requestId, {
            clientId: client.id,
            op: JSON.stringify(frame.op),
            receipt: { requestId: frame.requestId, status: 'pending' },
          })
      }),
      status: vi.fn((clientId, requestId, connectionId) => {
        const old = records.get(requestId)
        adapter.deliver(
          clientId,
          old && old.clientId === clientId ? old.receipt : { requestId, status: 'unknown' },
          connectionId,
        )
      }),
    },
  }
  const adapter = createLaneAdapter(service, limits)
  const connections: ReturnType<typeof createConnection>[] = []
  function connect(client = claims.client) {
    const pair = createLoopbackPair()
    const frames: HostFrame[] = []
    const codes: number[] = []
    pair.client.onMessage((text) => {
      const parsed = parseHostFrame(text)
      if (!parsed.ok) throw new Error('Invalid Host frame')
      frames.push(parsed.value)
    })
    pair.client.onClose((code) => codes.push(code))
    const connection = createConnection({
      socket: pair.server,
      authority,
      origin: claims.iss,
      hello: {
        hostId: claims.hostId,
        hostVersion: 'test',
        protocolVersion: 1,
        runtimeEpoch: epoch,
        capabilities: [...service.capabilities],
      },
      key: host.privateKey,
      keyset: { get: async () => control.publicKey },
      admit: () => true,
      handler: adapter.handler,
    })
    connections.push(connection)
    const send = (frame: unknown) => pair.client.send(JSON.stringify(frame))
    const auth = (caps: readonly HostCapability[] = claims.caps, initial = true) => {
      const grant = encodeGrant({ ...claims, client, caps }, (bytes) =>
        sign(null, bytes, control.privateKey),
      )
      send({
        type: 'auth',
        grant,
        ...(initial ? { challenge: 'a'.repeat(64), trace: '0123456789abcdef' } : {}),
      })
    }
    return { ...pair, connection, frames, codes, send, auth }
  }
  function done(requestId: string) {
    const row = records.get(requestId)
    if (!row) throw new Error('Missing command')
    row.receipt = { requestId, status: 'done', fence: 1 }
    adapter.deliver(row.clientId, row.receipt)
  }
  return {
    adapter,
    service,
    claims,
    records,
    connect,
    done,
    stop: () => connections.forEach((c) => c.close(1001)),
  }
}
const flush = () => vi.advanceTimersByTimeAsync(0)
const receipts = (frames: HostFrame[]) =>
  frames.filter((f) => f.type === 'receipt').map((f) => f.receipt)
const command = (requestId: string, type: 'abort' | 'abort_retry' = 'abort') => ({
  type: 'command',
  requestId,
  op: { type },
})

describe('lane adapter', () => {
  let h: ReturnType<typeof fixture>
  beforeEach(() => {
    vi.useFakeTimers()
    h = fixture()
  })
  afterEach(() => {
    h.stop()
    vi.useRealTimers()
  })
  async function ready(client = h.claims.client, caps: readonly HostCapability[] = h.claims.caps) {
    const c = h.connect(client)
    c.auth(caps)
    await flush()
    return c
  }
  it('allows receipt reads for viewers, refuses missing read permission and drops revoked pending data', async () => {
    h.service.calls.capabilityFor = () => 'sessions.read'
    const c = await ready(h.claims.client, ['sessions.read'])
    c.send({
      type: 'call',
      id: 'allowed',
      method: 'lane.receipt',
      params: { laneId: randomUUID() },
    })
    await flush()
    expect(c.frames).toContainEqual({ type: 'result', id: 'allowed', ok: true, data: null })
    c.auth(['sessions.control'], false)
    await flush()
    c.send({ type: 'call', id: 'denied', method: 'lane.receipt' })
    await flush()
    expect(c.frames).toContainEqual({
      type: 'result',
      id: 'denied',
      ok: false,
      error: { code: 'forbidden', message: 'forbidden' },
    })
    c.auth(['sessions.read'], false)
    await flush()
    let resolve: (value: CallOutcome) => void = () => {}
    h.service.calls.call = vi.fn(
      () =>
        new Promise<CallOutcome>((r) => {
          resolve = r
        }),
    )
    c.send({ type: 'call', id: 'pending', method: 'lane.receipt' })
    await flush()
    c.auth(['sessions.control'], false)
    await flush()
    resolve({ ok: true, data: 'private receipt' })
    await flush()
    expect(c.frames.some((f) => f.type === 'result' && f.id === 'pending')).toBe(false)
  })
  it('old Host unknown-method refusal keeps the socket and lane alive', async () => {
    h.service.calls.capabilityFor = () => null
    h.service.calls.call = vi.fn(async (): Promise<CallOutcome> => ({
      ok: false,
      error: { code: 'unsupported', message: 'the lane query could not complete' },
    }))
    const c = await ready(h.claims.client, ['sessions.read'])
    c.send({
      type: 'call',
      id: 'receipt',
      method: 'lane.receipt',
      params: { laneId: randomUUID() },
    })
    await flush()
    expect(c.frames).toContainEqual({
      type: 'result',
      id: 'receipt',
      ok: false,
      error: { code: 'unsupported', message: 'the lane query could not complete' },
    })
    expect(c.codes).toEqual([])
    expect(h.service.commands.submit).not.toHaveBeenCalled()
    c.send({ type: 'ping', at: 7 })
    await flush()
    expect(c.frames).toContainEqual({ type: 'pong', at: 7 })
  })
  it('admits machine routine reductions without lane control and gates starts twice', async () => {
    h.service.capabilities = ['sessions.read', 'sessions.control', 'routines']
    h.service.commands.capabilityFor = (op) => {
      const routine = parseRoutineOp(op)
      return routine
        ? routineRequiresControl(routine)
          ? ['routines', 'sessions.control']
          : ['routines']
        : ['sessions.control']
    }
    const viewer = await ready(h.claims.client, ['routines'])
    const reductionId = randomUUID()
    viewer.send({ type: 'command', requestId: reductionId, op: { type: 'routine.pauseAll' } })
    await flush()
    expect(h.service.commands.submit).toHaveBeenCalledTimes(1)
    const rejectedId = randomUUID()
    viewer.send({
      type: 'command',
      requestId: rejectedId,
      op: { type: 'routine.run', routineId: randomUUID() },
    })
    await flush()
    expect(receipts(viewer.frames).at(-1)).toMatchObject({
      requestId: rejectedId,
      status: 'rejected',
      code: 'forbidden',
    })
    const controller = await ready(h.claims.client, ['routines', 'sessions.control'])
    const requestId = randomUUID()
    controller.send({
      type: 'command',
      requestId,
      op: { type: 'routine.run', routineId: randomUUID() },
    })
    await flush()
    expect(h.service.commands.submit).toHaveBeenCalledTimes(2)
    controller.auth(['routines'], false)
    await flush()
    const sender = vi.mocked(h.service.commands.submit).mock.calls.at(-1)?.[0]
    expect(sender?.currentCaps?.()).toEqual(['routines'])
    h.done(requestId)
    await flush()
    expect(receipts(controller.frames).at(-1)).toMatchObject({ requestId, status: 'done' })
    controller.send({ type: 'receipt-status', requestId })
    await flush()
    expect(receipts(controller.frames).at(-1)?.status).toBe('done')
  })

  it('fans execution out only to interested same-client sockets; conflict is attempt-only', async () => {
    const a = await ready(),
      b = await ready(),
      uninterested = await ready()
    const foreign = await ready({ id: randomUUID(), label: 'Other' })
    const id = randomUUID()
    a.send(command(id))
    await flush()
    b.send(command(id))
    await flush()
    b.send(command(id, 'abort_retry'))
    await flush()
    foreign.send({ type: 'receipt-status', requestId: id })
    await flush()
    foreign.send(command(id))
    await flush()
    expect(receipts(a.frames)).toEqual([])
    expect(receipts(b.frames)).toEqual([
      { requestId: id, status: 'pending' },
      { requestId: id, status: 'rejected', code: 'conflict' },
    ])
    expect(receipts(foreign.frames)).toEqual([
      { requestId: id, status: 'unknown' },
      { requestId: id, status: 'rejected', code: 'conflict' },
    ])
    h.done(id)
    await flush()
    expect(receipts(a.frames)).toEqual([{ requestId: id, status: 'done', fence: 1 }])
    expect(receipts(b.frames).at(-1)).toEqual({ requestId: id, status: 'done', fence: 1 })
    expect(receipts(uninterested.frames)).toEqual([])
    expect(receipts(foreign.frames)).toHaveLength(2)
    h.adapter.deliver(h.claims.client.id, { requestId: id, status: 'done' })
    await flush()
    expect(receipts(a.frames)).toHaveLength(1)
    b.send(command(id))
    await flush()
    expect(receipts(b.frames).at(-1)).toEqual({ requestId: id, status: 'done', fence: 1 })
    expect(receipts(a.frames)).toHaveLength(1)
    // Connection ids are not authority: even a targeted reply stays client-scoped.
    h.adapter.deliver(
      foreign.frames[0]?.type === 'ready' ? foreign.frames[0].client.id : '',
      { requestId: id, status: 'done' },
      a.connection.connectionId,
    )
    await flush()
    expect(receipts(a.frames)).toHaveLength(1)
  })
  it('registers status interest before a synchronous pending reply and clears existing terminal interest', async () => {
    const a = await ready(),
      b = await ready(),
      id = randomUUID()
    a.send(command(id))
    await flush()
    b.send({ type: 'receipt-status', requestId: id })
    await flush()
    expect(receipts(b.frames)).toEqual([{ requestId: id, status: 'pending' }])
    h.done(id)
    await flush()
    expect(receipts(b.frames).at(-1)).toMatchObject({ requestId: id, status: 'done' })
    b.send({ type: 'receipt-status', requestId: id })
    await flush()
    const cut = b.frames.length
    h.adapter.deliver(h.claims.client.id, { requestId: id, status: 'done' })
    await flush()
    expect(b.frames).toHaveLength(cut)
  })
  it('bounds unanswered commands, including after a conflict, and frees a terminal slot', async () => {
    h.stop()
    h = fixture({ limits: { pendingCommandsPerConnection: 1 } })
    const a = await ready(),
      id = randomUUID(),
      next = randomUUID()
    a.send(command(id))
    a.send(command(id))
    a.send(command(id, 'abort_retry'))
    a.send(command(next))
    await flush()
    expect(h.service.commands.submit).toHaveBeenCalledTimes(3)
    expect(receipts(a.frames).at(-1)).toEqual({
      requestId: next,
      status: 'rejected',
      code: 'too-many-requests',
    })
    expect(a.codes).toEqual([])
    h.done(id)
    await flush()
    a.send(command(next))
    await flush()
    expect(h.service.commands.submit).toHaveBeenCalledTimes(4)
  })
  it('evicts oldest status interest beyond twice the command cap without evicting commands', async () => {
    h.stop()
    h = fixture({ limits: { pendingCommandsPerConnection: 1 } })
    h.service.commands.status = vi.fn() // Hold status replies to exercise the interest bound.
    const a = await ready(),
      id = randomUUID(),
      first = randomUUID(),
      last = randomUUID()
    a.send(command(id))
    a.send({ type: 'receipt-status', requestId: id })
    a.send({ type: 'receipt-status', requestId: first })
    a.send({ type: 'receipt-status', requestId: last })
    await flush()
    for (const requestId of [first, last])
      h.adapter.deliver(h.claims.client.id, { requestId, status: 'done' })
    h.done(id)
    await flush()
    expect(receipts(a.frames).map((r) => r.requestId)).toEqual([last, id])
  })
  it.each(['workspaces.read', 'skills.read', 'artifacts.read'] as const)(
    'gates feature calls on %s, not sessions.read, and permits unsupported replies',
    async (capability) => {
      h.service.capabilities = ['sessions.read', capability]
      h.service.calls.capabilityFor = (method) => (method === 'unknown.read' ? null : capability)
      const a = h.connect()
      a.auth(['sessions.read'])
      await flush()
      a.send({ type: 'call', id: 'denied', method: 'feature.read' })
      await flush()
      expect(a.frames.at(-1)).toMatchObject({ type: 'result', error: { code: 'forbidden' } })
      expect(h.service.calls.call).not.toHaveBeenCalled()
      a.auth([capability], false)
      await flush()
      a.send({ type: 'call', id: 'allowed', method: 'feature.read' })
      await flush()
      expect(a.frames.at(-1)).toMatchObject({ type: 'result', id: 'allowed', ok: true })
      h.service.calls.call = vi.fn(async (): Promise<CallOutcome> => ({
        ok: false,
        error: { code: 'unsupported', message: 'unsupported' },
      }))
      a.auth([], false)
      await flush()
      a.send({ type: 'call', id: 'unknown', method: 'unknown.read' })
      await flush()
      expect(a.frames.at(-1)).toMatchObject({ type: 'result', error: { code: 'unsupported' } })
    },
  )
  it.each([
    ['artifacts.read', false],
    ['artifacts.read', true],
    ['workspaces.read', false],
    ['workspaces.read', true],
    ['skills.read', false],
    ['skills.read', true],
  ] as const)(
    'suppresses %s results and errors after renewal loss (error: %s)',
    async (capability, failure) => {
      h.service.capabilities = ['sessions.read', capability]
      h.service.calls.capabilityFor = () => capability
      let resolve: (outcome: CallOutcome) => void = () => {}
      let reject: (error: Error) => void = () => {}
      h.service.calls.call = vi.fn(
        () =>
          new Promise<CallOutcome>((r, fail) => {
            resolve = r
            reject = fail
          }),
      )
      const a = h.connect()
      a.auth(['sessions.read', capability])
      await flush()
      a.send({ type: 'call', id: 'pending', method: 'feature.read' })
      await flush()
      a.auth(['sessions.read'], false)
      await flush()
      if (failure) reject(new Error('private output'))
      else resolve({ ok: true, data: 'private output' })
      await flush()
      expect(a.frames.some((frame) => frame.type === 'result')).toBe(false)
    },
  )
  it('caps concurrent calls at the exact limit then closes 4429', async () => {
    h.stop()
    h = fixture({ limits: { pendingCommandsPerConnection: 1 } })
    const a = await ready()
    a.send({ type: 'call', id: 'completed', method: 'lane.state' })
    await flush()
    expect(a.frames.at(-1)).toMatchObject({ type: 'result', id: 'completed', ok: true })
    h.service.calls.call = vi.fn(() => new Promise<CallOutcome>(() => {}))
    a.send({ type: 'call', id: 'one', method: 'lane.state' })
    await flush()
    expect(a.codes).toEqual([])
    a.send({ type: 'call', id: 'two', method: 'lane.state' })
    await flush()
    expect(a.codes).toEqual([4429])
    expect(h.service.calls.call).toHaveBeenCalledTimes(1)
    expect(h.adapter.isConnected(h.claims.client.id)).toBe(false)
  })
  it('bounds the full serialized call result, with a too-large result instead of closing', async () => {
    h.stop()
    h = fixture({ limits: { outboundFrameBytes: 200 } })
    const a = await ready()
    const overhead = Buffer.byteLength(
      JSON.stringify({ type: 'result', id: 'x', ok: true, data: '' }),
    )
    h.service.calls.call = vi.fn(async (): Promise<CallOutcome> => ({
      ok: true,
      data: 'x'.repeat(200 - overhead),
    }))
    a.send({ type: 'call', id: 'x', method: 'lane.messages' })
    await flush()
    expect(a.frames.at(-1)).toMatchObject({ type: 'result', ok: true })
    h.service.calls.call = vi.fn(async (): Promise<CallOutcome> => ({
      ok: true,
      data: 'x'.repeat(201 - overhead),
    }))
    a.send({ type: 'call', id: 'x', method: 'lane.messages' })
    await flush()
    expect(a.frames.at(-1)).toMatchObject({
      type: 'result',
      ok: false,
      error: { code: 'too-large' },
    })
    h.service.calls.call = vi.fn(async (): Promise<CallOutcome> => ({
      ok: true,
      data: 'é'.repeat(100),
    }))
    a.send({ type: 'call', id: 'unicode', method: 'lane.messages' })
    await flush()
    expect(a.frames.at(-1)).toMatchObject({
      type: 'result',
      id: 'unicode',
      error: { code: 'too-large' },
    })
    expect(a.codes).toEqual([])
  })
  it('intersects capabilities and gates commands, subscriptions and calls but not status', async () => {
    h.service.capabilities = ['sessions.read']
    const a = await ready()
    expect(a.frames[0]).toMatchObject({ type: 'ready', capabilities: ['sessions.read'] })
    a.send(command(randomUUID()))
    await flush()
    expect(receipts(a.frames).at(-1)).toMatchObject({ code: 'forbidden' })
    expect(h.service.commands.submit).not.toHaveBeenCalled()
    const b = await ready(h.claims.client, [])
    b.send({ type: 'subscribe', id: 's', topic: 'lanes' })
    b.send({ type: 'call', id: 'c', method: 'lane.state' })
    b.send({ type: 'receipt-status', requestId: randomUUID() })
    await flush()
    expect(b.frames.slice(1)).toMatchObject([
      { type: 'subscribe-failed', code: 'forbidden' },
      { type: 'result', error: { code: 'forbidden' } },
      { type: 'receipt', receipt: { status: 'unknown' } },
    ])
    expect(h.service.calls.call).not.toHaveBeenCalled()
    expect(h.service.commands.status).toHaveBeenCalledOnce()
  })
  it('requires write and control capabilities at admission but delivers owner receipts after renewal', async () => {
    h.service.capabilities = ['sessions.read', 'sessions.control', 'workspaces.write']
    h.service.commands.capabilityFor = (op) =>
      op.type.startsWith('files.') ? ['workspaces.write', 'sessions.control'] : null
    const a = await ready()
    const requestId = randomUUID()
    const frame = {
      type: 'command',
      requestId,
      laneId: randomUUID(),
      fence: 1,
      op: { type: 'files.create', path: 'a', kind: 'file' },
    }
    a.send(frame)
    await flush()
    expect(receipts(a.frames).at(-1)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    expect(h.service.commands.submit).not.toHaveBeenCalled()
    a.auth(['workspaces.write'], false)
    await flush()
    a.send(frame)
    await flush()
    expect(h.service.commands.submit).not.toHaveBeenCalled()
    a.auth(['sessions.control', 'workspaces.write'], false)
    await flush()
    a.send(frame)
    await flush()
    expect(h.service.commands.submit).toHaveBeenCalledOnce()
    const sender = vi.mocked(h.service.commands.submit).mock.calls[0]?.[0]
    expect(sender?.currentCaps?.()).toContain('workspaces.write')
    a.auth([], false)
    await flush()
    expect(sender?.currentCaps?.()).toEqual([])
    h.adapter.deliver(h.claims.client.id, { requestId, status: 'done' })
    await flush()
    expect(receipts(a.frames).at(-1)).toMatchObject({ requestId, status: 'done' })
    a.send({ type: 'receipt-status', requestId })
    await flush()
    expect(h.service.commands.status).toHaveBeenCalled()
    a.auth(['sessions.control', 'workspaces.write'], false)
    await flush()
    expect(sender?.currentCaps?.()).toContain('workspaces.write')
    h.stop()
    expect(sender?.currentCaps?.()).toEqual([])
  })
  it('forwards subscription limits and unsubscribe without retaining old topic listeners', async () => {
    h.stop()
    h = fixture({ limits: { subscriptionsPerConnection: 1 } })
    const a = await ready()
    a.send({ type: 'subscribe', id: 'first', topic: 'lanes' })
    a.send({ type: 'subscribe', id: 'excess', topic: 'lanes' })
    await flush()
    expect(a.frames.at(-1)).toMatchObject({
      type: 'subscribe-failed',
      id: 'excess',
      code: 'too-many',
    })
    a.send({ type: 'unsubscribe', id: 'first' })
    a.send({ type: 'subscribe', id: 'new', topic: 'lanes' })
    await flush()
    expect(a.frames.at(-1)).toMatchObject({ type: 'lanes', id: 'new' })
    const cut = a.frames.length
    h.service.lanesTopic.delta([])
    await flush()
    expect(a.frames.slice(cut)).toMatchObject([{ type: 'lanes-delta', id: 'new' }])
  })
  it('drops subscriptions on read loss and creates a fresh manager on regain', async () => {
    const a = await ready()
    a.send({ type: 'subscribe', id: 's', topic: 'lanes' })
    await flush()
    expect(a.frames.at(-1)).toMatchObject({ type: 'lanes' })
    a.auth(['sessions.control'], false)
    await flush()
    const cut = a.frames.length
    h.service.lanesTopic.delta([])
    await flush()
    expect(a.frames).toHaveLength(cut)
    expect(a.frames.some((f) => f.type === 'subscribe-failed')).toBe(false)
    a.auth(h.claims.caps, false)
    await flush()
    a.send({ type: 'subscribe', id: 's', topic: 'lanes' })
    await flush()
    h.service.lanesTopic.delta([])
    await flush()
    expect(a.frames.at(-1)).toMatchObject({ type: 'lanes-delta' })
  })
  it.each([
    ['read loss', false],
    ['close', false],
    ['read loss', true],
    ['close', true],
  ] as const)(
    'does not send an async call result after %s (failure: %s)',
    async (action, failure) => {
      let resolve: (outcome: CallOutcome) => void = () => {}
      let reject: (reason: Error) => void = () => {}
      h.service.calls.call = vi.fn(
        () =>
          new Promise<CallOutcome>((r, fail) => {
            resolve = r
            reject = fail
          }),
      )
      const a = await ready()
      a.send({ type: 'call', id: 'c', method: 'lane.state' })
      await flush()
      if (action === 'read loss') a.auth(['sessions.control'], false)
      else a.sever()
      await flush()
      const accessed = vi.fn()
      if (failure) reject(new Error('private answer'))
      else
        resolve({
          ok: true,
          data: {
            get value() {
              accessed()
              return 'private answer'
            },
          },
        })
      await flush()
      expect(accessed).not.toHaveBeenCalled()
      expect(a.frames.some((f) => f.type === 'result')).toBe(false)
    },
  )
  it('publishes presence only at first ready and last close, not at a pre-ready close', async () => {
    const pre = h.connect()
    pre.sever()
    await flush()
    expect(h.service.controllerPresence).not.toHaveBeenCalled()
    const a = await ready(),
      b = await ready()
    expect(h.adapter.isConnected(h.claims.client.id)).toBe(true)
    expect(h.service.controllerPresence).toHaveBeenCalledTimes(1)
    a.sever()
    await flush()
    expect(h.adapter.isConnected(h.claims.client.id)).toBe(true)
    expect(h.service.controllerPresence).toHaveBeenCalledTimes(1)
    b.connection.close(1001)
    // Presence changes at admission close, not at the delayed transport callback.
    expect(h.adapter.isConnected(h.claims.client.id)).toBe(false)
    await flush()
    expect(h.adapter.isConnected(h.claims.client.id)).toBe(false)
    expect(h.service.controllerPresence).toHaveBeenCalledTimes(2)
  })
  it('fails closed on a submit exception and gives fixed call errors without child text', async () => {
    const a = await ready()
    h.service.calls.call = vi.fn(async () => {
      throw new Error('private child text')
    })
    a.send({ type: 'call', id: 'c', method: 'lane.state' })
    await flush()
    expect(a.frames.at(-1)).toEqual({
      type: 'result',
      id: 'c',
      ok: false,
      error: { code: 'internal', message: 'internal' },
    })
    h.service.commands.submit = vi.fn(async () => {
      throw new Error('private child text')
    })
    a.send(command(randomUUID()))
    await flush()
    expect(a.codes).toEqual([4429])
    expect(JSON.stringify(a.frames)).not.toContain('private child text')
  })
  it.each(['submit', 'status'] as const)(
    'closes on a synchronous %s failure without leaking it',
    async (kind) => {
      const a = await ready()
      h.service.commands[kind] = vi.fn(() => {
        throw new Error('private service text')
      })
      a.send(
        kind === 'submit'
          ? command(randomUUID())
          : { type: 'receipt-status', requestId: randomUUID() },
      )
      await flush()
      expect(a.codes).toEqual([4429])
      expect(JSON.stringify(a.frames)).not.toContain('private service text')
    },
  )
  it('bounds the transport backlog and validates lower-only limits', async () => {
    h.stop()
    h = fixture({ limits: { sendQueueBytes: 200 } })
    const a = await ready()
    a.pause()
    for (let i = 0; i < 5; i++)
      h.adapter.deliver(
        h.claims.client.id,
        { requestId: randomUUID(), status: 'done' },
        a.connection.connectionId,
      )
    a.resume()
    await flush()
    expect(a.codes).toEqual([4429])
    for (const value of [0, 1.5, HOST_LIMITS.pendingCommandsPerConnection + 1])
      expect(() =>
        createLaneAdapter(h.service, { limits: { pendingCommandsPerConnection: value } }),
      ).toThrow()
  })
})

it('logs safe connection trace, command admission and receipt delivery without wire ids or content', async () => {
  vi.useFakeTimers()
  const events: unknown[] = []
  const h = fixture({ log: (event, fields) => events.push({ event, ...fields }) })
  try {
    const c = h.connect()
    c.auth()
    await flush()
    const requestId = randomUUID()
    c.send({ type: 'command', requestId, op: { type: 'prompt', message: '/private/content' } })
    await flush()
    h.done(requestId)
    expect(events).toEqual([
      { event: 'api.command', trace: '0123456789abcdef', op: 'prompt' },
      { event: 'api.receipt', trace: '0123456789abcdef', status: 'done' },
    ])
    expect(JSON.stringify(events)).not.toContain(requestId)
    expect(JSON.stringify(events)).not.toContain('/private/content')
    for (const event of events) {
      if (!event || typeof event !== 'object') throw new Error('Missing log')
      for (const value of Object.values(event))
        expect(String(value)).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
    }
  } finally {
    h.stop()
    vi.useRealTimers()
  }
})
