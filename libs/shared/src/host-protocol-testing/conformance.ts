import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_LIMITS,
  parseHostFrame,
  type FrameSocket,
  type HostFrame,
  type ClientFrame,
  type LaneOp,
} from '../host-protocol'
import { CONTROL_LIMITS } from '../control-api'
import type { HostCapability } from '../remote-host'
import type { GrantPayload } from '../host-grant'
import type { ExtensionUIRequest } from '../rpc'

export interface ConformanceConnection {
  socket: FrameSocket
  pause(): void
  resume(): void
  sever(): void
}
export interface HostConformanceHarness {
  claims: GrantPayload
  repositoryId?: string
  /** Exact scenario titles mapped to visible reasons; omitted when all scenarios are supported. */
  skippedScenarios?: Readonly<Record<string, string>>
  publicKey: Uint8Array
  connect(): ConformanceConnection
  mintGrant(claims?: Partial<GrantPayload>, badSignature?: boolean): string
  verifyProof(ready: Extract<HostFrame, { type: 'ready' }>, challenge: string): boolean
  signHelloProof(hostId: string, runtimeEpoch: string, challenge: string): string
  requestId(): string
  driver: {
    emitTurn(laneId: string): { messages: number; turns: number }
    openDialog(laneId: string, dialogId?: string): void
    failLane(laneId: string): void
    emitUi(laneId: string, request: ExtensionUIRequest): void
    restart(): void | Promise<void>
    revokeSession(id: string): void
    revokeClient(id: string): void
    executions(): number
    stop(): void | Promise<void>
  }
}
export interface ConformanceOptions {
  authTimeoutMs: number
  subscriptionsPerConnection: number
  pendingCommandsPerConnection: number
  replayEvents: number
  commandDelayMs: number
  inboundFrameBytes: number
  outboundFrameBytes: number
  sendQueueBytes: number
  receiptsKept: number
  receiptTtlMs: number
  connectionsPerClient: number
  replayBytes: number
  attentionReplay: number
  uiStatusKeys: number
  uiWidgetKeys: number
}
export type HostConformanceFactory = (
  limits: Partial<ConformanceOptions>,
) => HostConformanceHarness | Promise<HostConformanceHarness>
const scenarioPendingCap = 2
const challenge = 'a'.repeat(64)
const otherClient = { id: '00000000-0000-4000-8000-000000000002', label: 'Other viewer' }

/** The same scenarios run against the model and the real Host adapter. No fake internals. */
export function defineHostConformance(
  name: string,
  factory: HostConformanceFactory,
  options: { capabilities?: readonly HostCapability[] } = {},
) {
  const announced = options.capabilities ?? ['sessions.read', 'sessions.control']
  const lacks = (...caps: HostCapability[]) => !caps.every((cap) => announced.includes(cap))
  describe(name, () => {
    let h: HostConformanceHarness
    beforeEach(async (t) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      h = await factory({
        authTimeoutMs: 20,
        commandDelayMs: 5,
        subscriptionsPerConnection: 3,
        pendingCommandsPerConnection: scenarioPendingCap,
        replayEvents: 30,
      })
      const reason = h.skippedScenarios?.[t.task.name]
      if (reason !== undefined) {
        if (!reason.trim()) throw new Error('A skipped scenario requires a reason')
        t.skip(reason)
      }
    })
    afterEach(async () => {
      try {
        await h?.driver.stop()
      } finally {
        vi.useRealTimers()
      }
    })
    async function flush(ms = 0) {
      await vi.advanceTimersByTimeAsync(ms)
    }
    function client() {
      const connection = h.connect()
      const frames: HostFrame[] = [],
        closed: number[] = []
      connection.socket.onMessage((text) => {
        const p = parseHostFrame(text)
        if (!p.ok) throw new Error('Invalid Host frame: ' + p.reason)
        frames.push(p.value)
      })
      connection.socket.onClose((code) => closed.push(code))
      return {
        ...connection,
        frames,
        closed,
        send(f: ClientFrame) {
          connection.socket.send(JSON.stringify(f))
        },
      }
    }
    async function auth(claims: Partial<GrantPayload> = {}) {
      const c = client()
      c.send({ type: 'auth', grant: h.mintGrant(claims), challenge })
      await flush()
      expect(c.frames[0]?.type).toBe('ready')
      return c
    }
    type Viewer = Awaited<ReturnType<typeof auth>>
    function receipts(c: Viewer, id?: string) {
      return c.frames.flatMap((f) =>
        f.type === 'receipt' && (!id || f.receipt.requestId === id) ? [f.receipt] : [],
      )
    }
    async function create(c: Viewer) {
      let repositoryId = h.repositoryId
      if (repositoryId === undefined) {
        const id = h.requestId()
        c.send({ type: 'call', id, method: 'host.repositories', params: {} })
        await flush()
        const result = c.frames.find((f) => f.type === 'result' && f.id === id)
        if (!result || result.type !== 'result' || !result.ok || !Array.isArray(result.data))
          throw new Error('Missing repositories')
        const first: unknown = result.data[0]
        if (!first || typeof first !== 'object' || !('id' in first) || typeof first.id !== 'string')
          throw new Error('Missing repository id')
        repositoryId = first.id
      }
      const id = h.requestId()
      c.send({
        type: 'command',
        requestId: id,
        op: { type: 'lane.create', repositoryId, worktree: null },
      })
      await flush(5)
      const r = receipts(c, id)[0]
      expect(r?.status).toBe('done')
      if (!r || r.status !== 'done' || !r.laneId) throw new Error('No created lane')
      return r.laneId
    }
    async function command(c: Viewer, laneId: string, op: LaneOp, fence = 1) {
      const requestId = h.requestId()
      c.send({ type: 'command', requestId, laneId, fence, op })
      await flush(5)
      const r = receipts(c, requestId).at(-1)
      if (!r) throw new Error('Missing receipt')
      return r
    }
    function events(c: Viewer, id = 'lane') {
      return c.frames.filter(
        (f): f is Extract<HostFrame, { type: 'event' }> => f.type === 'event' && f.id === id,
      )
    }
    function snapshots(c: Viewer) {
      return c.frames.filter(
        (f): f is Extract<HostFrame, { type: 'snapshot' }> => f.type === 'snapshot',
      )
    }

    it('requires auth as the first frame and enforces its deadline', async () => {
      const c = client()
      c.send({ type: 'ping', at: 0 })
      await flush()
      expect(c.closed).toEqual([4401])
      const timeout = client()
      await flush(20)
      expect(timeout.closed).toEqual([4401])
    })
    it.each(['signature', 'host', 'epoch', 'owner'] as const)('refuses a wrong %s', async (bad) => {
      const c = client()
      const claims =
        bad === 'host'
          ? { hostId: otherClient.id }
          : bad === 'epoch'
            ? { epoch: h.claims.epoch + 1 }
            : bad === 'owner'
              ? { sub: otherClient.id }
              : {}
      c.send({ type: 'auth', grant: h.mintGrant(claims, bad === 'signature'), challenge })
      await flush()
      expect(c.closed).toEqual([bad === 'signature' ? 4401 : 4403])
    })
    it('proves the enrolled Host, renews, rejects identity changes, and expires', async () => {
      const c = await auth()
      const ready = c.frames[0]
      if (!ready || ready.type !== 'ready') throw new Error('Missing ready')
      expect(ready.hello.hostId).toBe(h.claims.hostId)
      expect(h.publicKey.length).toBe(32)
      expect(h.verifyProof(ready, challenge)).toBe(true)
      expect(h.verifyProof(ready, 'b'.repeat(64))).toBe(false)
      c.send({ type: 'auth', grant: h.mintGrant() })
      await flush()
      expect(c.frames.at(-1)?.type).toBe('auth-renewed')
      c.send({ type: 'auth', grant: h.mintGrant({ client: otherClient }) })
      await flush()
      expect(c.closed).toEqual([4403])
      const expiring = await auth({ exp: h.claims.iat + 1 })
      await flush(30_000)
      expiring.send({ type: 'ping', at: 30_000 })
      await flush()
      expect(expiring.frames.at(-1)).toEqual({ type: 'pong', at: 30_000 })
      await flush((1 + CONTROL_LIMITS.signatureSkewSec) * 1000 - 30_000 - 1)
      expect(expiring.socket.isOpen()).toBe(true)
      await flush(1)
      expect(expiring.closed).toEqual([4401])
    })
    it('refuses a correctly signed hello naming a different enrolled Host', async () => {
      const c = await auth()
      const ready = c.frames.find((frame) => frame.type === 'ready')
      if (!ready || ready.type !== 'ready') throw new Error('Missing ready')
      const hostId = otherClient.id
      const wrongHost = {
        ...ready,
        hello: { ...ready.hello, hostId },
        proof: h.signHelloProof(hostId, ready.hello.runtimeEpoch, challenge),
      }
      expect(h.verifyProof(wrongHost, challenge)).toBe(false)
    })
    it.each(['session', 'client'] as const)(
      'closes open sockets and rejects revoked %s grants',
      async (kind) => {
        const c = await auth()
        if (kind === 'session') h.driver.revokeSession(h.claims.sid)
        else h.driver.revokeClient(h.claims.client.id)
        await flush()
        expect(c.closed).toEqual([4403])
        const next = client()
        next.send({ type: 'auth', grant: h.mintGrant(), challenge })
        await flush()
        expect(next.closed).toEqual([4403])
      },
    )
    it('closes malformed JSON and oversize input, but rejects unknown operations without closing', async () => {
      const c = await auth()
      const requestId = h.requestId()
      c.socket.send(
        JSON.stringify({
          type: 'command',
          requestId,
          op: { type: 'bash', command: 'not allowed' },
        }),
      )
      await flush()
      expect(receipts(c, requestId)).toEqual([
        { requestId, status: 'rejected', code: 'unsupported' },
      ])
      expect(c.socket.isOpen()).toBe(true)
      c.socket.send('{')
      await flush()
      expect(c.closed).toEqual([4400])
      await h.driver.stop()
      h = await factory({ inboundFrameBytes: 2048 })
      const oversized = await auth()
      oversized.socket.send(' '.repeat(2049))
      await flush()
      expect(oversized.closed).toEqual([4400])
    })
    it('lists lanes, publishes deltas, replays attention only within the current epoch', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const c = await auth()
      c.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
      await flush()
      const initial = c.frames.find((f) => f.type === 'lanes')
      if (!initial || initial.type !== 'lanes') throw new Error('Missing lanes')
      expect(initial.lanes).toEqual([])
      expect(initial.cursor.seq).toBe(0)
      const laneId = await create(c)
      h.driver.emitTurn(laneId)
      await flush()
      expect(c.frames.some((f) => f.type === 'lanes-delta' && f.upsert[0]?.laneId === laneId)).toBe(
        true,
      )
      const a = c.frames.find((f) => f.type === 'attention')
      expect(a?.type).toBe('attention')
      c.send({ type: 'unsubscribe', id: 'all' })
      c.send({ type: 'subscribe', id: 'again', topic: 'lanes', after: initial.cursor })
      await flush()
      expect(c.frames.filter((f) => f.type === 'attention' && f.id === 'again')).toHaveLength(1)
      await h.driver.restart()
      await flush()
      const next = await auth()
      next.send({ type: 'subscribe', id: 'new', topic: 'lanes', after: initial.cursor })
      await flush()
      expect(next.frames.filter((f) => f.type === 'attention')).toHaveLength(0)
    })
    it('snapshots, emits ordered events, replays exactly missed events, and resets across a gap or epoch', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const c = await auth(),
        laneId = await create(c)
      c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      await flush()
      const start = snapshots(c)[0]
      if (!start) throw new Error('Missing snapshot')
      const sessionId = start.snapshot.state?.sessionId
      expect(sessionId).toEqual(expect.any(String))
      expect(sessionId?.length).toBeGreaterThan(0)
      h.driver.emitTurn(laneId)
      await flush()
      const stream = events(c)
      expect(stream.map((e) => e.cursor.seq)).toEqual(
        stream.map((_, i) => start.snapshot.cursor.seq + i + 1),
      )
      const cut = stream[2]
      if (!cut) throw new Error('No cursor')
      c.send({ type: 'unsubscribe', id: 'lane' })
      c.send({ type: 'subscribe', id: 'resume', topic: 'lane', laneId, after: cut.cursor })
      await flush()
      expect(events(c, 'resume').map((f) => f.event)).toEqual(stream.slice(3).map((f) => f.event))
      expect(snapshots(c)).toHaveLength(1)
      for (let i = 0; i < 5; i++) h.driver.emitTurn(laneId)
      c.send({ type: 'unsubscribe', id: 'resume' })
      c.send({ type: 'subscribe', id: 'old', topic: 'lane', laneId, after: cut.cursor })
      await flush()
      expect(snapshots(c).at(-1)?.reset).toBe(true)
      expect(snapshots(c).at(-1)?.snapshot.state?.sessionId).toBe(sessionId)
      await h.driver.restart()
      await flush()
      const next = await auth()
      next.send({ type: 'subscribe', id: 'new', topic: 'lane', laneId, after: cut.cursor })
      await flush()
      expect(snapshots(next)[0]?.reset).toBe(true)
    })
    it('deduplicates running commands, sends pending then one terminal receipt, and rejects conflicting reuse', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const c = await auth(),
        laneId = await create(c),
        requestId = h.requestId()
      const frame: ClientFrame = {
        type: 'command',
        requestId,
        laneId,
        fence: 1,
        op: { type: 'prompt', message: 'Hello' },
      }
      const before = h.driver.executions()
      c.send(frame)
      c.send(frame)
      await flush()
      expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending'])
      await flush(5)
      expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending', 'done'])
      expect(h.driver.executions()).toBe(before + 1)
      const observer = await auth()
      c.send(frame)
      await flush()
      expect(receipts(c, requestId).filter((r) => r.status === 'done')).toHaveLength(2)
      expect(receipts(observer, requestId)).toEqual([])
      expect(h.driver.executions()).toBe(before + 1)
      c.send({ ...frame, op: { type: 'abort' } })
      await flush()
      expect(receipts(c, requestId).at(-1)).toMatchObject({ status: 'rejected', code: 'conflict' })
    })
    it('resends on a new socket mid-command without executing twice', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const c = await auth(),
        laneId = await create(c),
        requestId = h.requestId()
      const frame: ClientFrame = {
        type: 'command',
        requestId,
        laneId,
        fence: 1,
        op: { type: 'prompt', message: 'Hello' },
      }
      const before = h.driver.executions()
      c.send(frame)
      await flush()
      c.sever()
      await flush()
      const next = await auth()
      next.send(frame)
      await flush()
      expect(receipts(next, requestId).map((r) => r.status)).toEqual(['pending'])
      await flush(5)
      expect(receipts(next, requestId).map((r) => r.status)).toEqual(['pending', 'done'])
      expect(h.driver.executions()).toBe(before + 1)
    })
    it.for([HOST_LIMITS.commandAnswerMs - 1, HOST_LIMITS.commandAnswerMs + 1])(
      'answers once when pi completes at %i ms around the uncertainty deadline',
      async (commandDelayMs, t) => {
        if (lacks('sessions.read', 'sessions.control'))
          t.skip('requires sessions.read and sessions.control')
        await h.driver.stop()
        h = await factory({ commandDelayMs })
        const c = await auth(),
          laneId = await create(c),
          requestId = h.requestId()
        const frame: ClientFrame = {
          type: 'command',
          requestId,
          laneId,
          fence: 1,
          op: { type: 'prompt', message: 'Hello' },
        }
        c.send(frame)
        c.send(frame)
        await flush()
        expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending'])
        await flush(HOST_LIMITS.commandAnswerMs - 2)
        expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending'])
        await flush(1)
        const status = commandDelayMs < HOST_LIMITS.commandAnswerMs ? 'done' : 'unknown'
        expect(receipts(c, requestId).map((r) => r.status)).toEqual(
          status === 'done' ? ['pending', 'done'] : ['pending'],
        )
        await flush(1)
        expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending', status])
        await flush(2)
        expect(receipts(c, requestId).map((r) => r.status)).toEqual(['pending', status])
        const lookup = await auth()
        lookup.send({ type: 'receipt-status', requestId })
        await flush()
        expect(receipts(lookup, requestId)).toMatchObject([{ status }])
      },
    )
    it('returns unknown for unrecorded, pruned, another client, and interrupted requests; returns stored results', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const c = await auth(),
        laneId = await create(c),
        missing = h.requestId()
      c.send({ type: 'receipt-status', requestId: missing })
      await flush()
      expect(receipts(c, missing)).toEqual([{ requestId: missing, status: 'unknown' }])
      const requestId = h.requestId()
      c.send({
        type: 'command',
        requestId,
        laneId,
        fence: 1,
        op: { type: 'prompt', message: 'Hello' },
      })
      await flush()
      const other = await auth({ client: otherClient })
      other.send({ type: 'receipt-status', requestId })
      await flush()
      expect(receipts(other, requestId)).toEqual([{ requestId, status: 'unknown' }])
      await h.driver.restart()
      await flush()
      const next = await auth()
      next.send({ type: 'receipt-status', requestId })
      await flush()
      expect(receipts(next, requestId)).toEqual([{ requestId, status: 'unknown' }])
      const done = await command(next, laneId, { type: 'lane.markRead', upTo: 0 })
      const reconnect = await auth()
      reconnect.send({ type: 'receipt-status', requestId: done.requestId })
      await flush()
      expect(receipts(reconnect, done.requestId)).toEqual([done])
    })
    it('reports an interrupted running command as unknown without resurrecting a failed lane', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const c = await auth(),
        laneId = await create(c),
        requestId = h.requestId()
      c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      c.send({
        type: 'command',
        requestId,
        laneId,
        fence: 1,
        op: { type: 'prompt', message: 'Hello' },
      })
      await flush()
      h.driver.failLane(laneId)
      h.driver.emitUi(laneId, {
        type: 'extension_ui_request',
        id: 'notice',
        method: 'notify',
        message: 'Unrelated activity',
      })
      await flush(5)
      expect(receipts(c, requestId)).toEqual([{ requestId, status: 'unknown' }])
      expect(
        events(c).findLast((frame) => frame.laneId === laneId && frame.event.kind === 'summary')
          ?.event,
      ).toMatchObject({
        kind: 'summary',
        summary: { activity: 'failed' },
      })
    })
    it('refuses control without the capability and runs the M2 calls', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const c = await auth(),
        laneId = await create(c),
        viewer = await auth({ client: otherClient, caps: ['sessions.read'] })
      expect(await command(viewer, laneId, { type: 'control.take' })).toMatchObject({
        status: 'rejected',
        code: 'forbidden',
      })
      const resultStart = c.frames.length
      for (const method of [
        'host.repositories',
        'lane.state',
        'lane.messages',
        'lane.stats',
        'lane.models',
        'lane.commands',
      ]) {
        c.send({ type: 'call', id: method.replace('.', '_'), method, params: { laneId } })
        await flush()
      }
      c.send({ type: 'call', id: 'unsupported', method: 'other.method', params: {} })
      await flush()
      expect(c.frames.slice(resultStart).filter((f) => f.type === 'result' && f.ok)).toHaveLength(6)
      expect(c.frames.at(-1)).toMatchObject({
        type: 'result',
        ok: false,
        error: { code: 'unsupported' },
      })
    })
    it('bounds in-flight calls at the configured pending cap', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const pendingCommandsPerConnection = scenarioPendingCap
      await h.driver.stop()
      h = await factory({ pendingCommandsPerConnection })
      const boundary = await auth(),
        laneId = await create(boundary)
      const resultsBefore = boundary.frames.filter((f) => f.type === 'result').length
      for (let i = 0; i < pendingCommandsPerConnection; i++)
        boundary.send({ type: 'call', id: 'call' + i, method: 'lane.state', params: { laneId } })
      await flush()
      expect(boundary.socket.isOpen()).toBe(true)
      expect(boundary.frames.filter((f) => f.type === 'result' && f.ok)).toHaveLength(
        resultsBefore + pendingCommandsPerConnection,
      )
      boundary.send({ type: 'call', id: 'released', method: 'lane.state', params: { laneId } })
      await flush()
      expect(boundary.frames.at(-1)).toMatchObject({ type: 'result', id: 'released', ok: true })
      const excess = await auth()
      for (let i = 0; i <= pendingCommandsPerConnection; i++)
        excess.send({ type: 'call', id: 'call' + i, method: 'lane.state', params: { laneId } })
      await flush()
      expect(excess.closed).toEqual([4429])
      expect(boundary.socket.isOpen()).toBe(true)
    })
    it('serializes takeover for all viewers, fences the old controller, releases and acquires before pi events', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const a = await auth(),
        laneId = await create(a),
        b = await auth({ client: otherClient })
      for (const c of [a, b]) c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      await flush()
      expect(await command(b, laneId, { type: 'abort' })).toMatchObject({
        status: 'rejected',
        code: 'not-controller',
        control: { controller: { clientId: h.claims.client.id } },
      })
      expect(await command(b, laneId, { type: 'control.take' })).toMatchObject({
        status: 'done',
        fence: 2,
      })
      const ae = events(a).find((e) => e.event.kind === 'control'),
        be = events(b).find((e) => e.event.kind === 'control')
      expect(ae?.cursor).toEqual(be?.cursor)
      expect(ae?.event).toEqual(be?.event)
      expect(await command(a, laneId, { type: 'abort' }, 1)).toMatchObject({
        status: 'rejected',
        code: 'stale-fence',
      })
      expect(await command(b, laneId, { type: 'control.release' }, 2)).toMatchObject({
        status: 'done',
        fence: 3,
      })
      a.frames.length = 0
      h.driver.emitUi(laneId, {
        type: 'extension_ui_request',
        id: 'notice',
        method: 'notify',
        message: 'Unrelated activity',
      })
      expect(await command(a, laneId, { type: 'prompt', message: 'Hello' }, 3)).toMatchObject({
        status: 'done',
        fence: 4,
      })
      const stream = events(a)
      const controlIndex = stream.findIndex((e) => e.event.kind === 'control')
      const piIndex = stream.findIndex(
        (e) => e.event.kind === 'pi' && e.event.push.kind === 'event',
      )
      expect(controlIndex).toBeGreaterThanOrEqual(0)
      expect(piIndex).toBeGreaterThan(controlIndex)
    })
    it('rejects a viewer dialog answer and resolves the controller answer in the stream', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const a = await auth(),
        laneId = await create(a),
        b = await auth({ client: otherClient })
      a.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      await flush()
      h.driver.openDialog(laneId)
      await flush()
      const op: LaneOp = {
        type: 'extension_ui_response',
        response: { type: 'extension_ui_response', id: 'dialog', confirmed: true },
      }
      expect(await command(b, laneId, op)).toMatchObject({
        status: 'rejected',
        code: 'not-controller',
      })
      expect(await command(a, laneId, op)).toMatchObject({ status: 'done' })
      expect(
        events(a).some((f) => f.event.kind === 'dialog-resolved' && f.event.dialogId === 'dialog'),
      ).toBe(true)
    })
    it('hydrates only latest status, widget and title state for a new viewer, and clears keys', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const a = await auth(),
        laneId = await create(a)
      const status = (key: string, statusText: string | undefined): ExtensionUIRequest => ({
        type: 'extension_ui_request',
        id: 'status',
        method: 'setStatus',
        statusKey: key,
        statusText,
      })
      h.driver.emitUi(laneId, status('one', 'old'))
      h.driver.emitUi(laneId, status('one', 'latest'))
      h.driver.emitUi(laneId, status('two', 'second'))
      h.driver.emitUi(laneId, {
        type: 'extension_ui_request',
        id: 'widget',
        method: 'setWidget',
        widgetKey: 'runs',
        widgetLines: ['latest widget'],
      })
      const b = await auth({ client: otherClient })
      b.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      await flush()
      expect(snapshots(b)[0]?.snapshot.ui).toHaveLength(3)
      expect(snapshots(b)[0]?.snapshot.ui).toContainEqual(status('one', 'latest'))
      h.driver.emitUi(laneId, status('one', undefined))
      h.driver.emitUi(laneId, {
        type: 'extension_ui_request',
        id: 'widget',
        method: 'setWidget',
        widgetKey: 'runs',
        widgetLines: [],
      })
      b.send({ type: 'unsubscribe', id: 'lane' })
      b.send({ type: 'subscribe', id: 'new', topic: 'lane', laneId })
      await flush()
      expect(snapshots(b).at(-1)?.snapshot.ui).toEqual([status('two', 'second')])
    })
    it('bounds subscriptions and pending commands at the configured cap', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const c = await auth(),
        laneId = await create(c)
      for (let i = 0; i < 4; i++) c.send({ type: 'subscribe', id: 's' + i, topic: 'lanes' })
      await flush()
      expect(c.frames.filter((f) => f.type === 'lanes')).toHaveLength(3)
      expect(c.frames.at(-1)).toMatchObject({ type: 'subscribe-failed', code: 'too-many' })
      const ids = [h.requestId(), h.requestId(), h.requestId()]
      for (const requestId of ids)
        c.send({ type: 'command', requestId, laneId, fence: 1, op: { type: 'abort' } })
      await flush()
      expect(receipts(c, ids[2])).toHaveLength(1)
      expect(receipts(c, ids[2])[0]).toMatchObject({
        status: 'rejected',
        code: 'too-many-requests',
      })
      await flush(5)
      expect(receipts(c).filter((r) => r.status === 'done')).toHaveLength(3)
    })
    it('stops and resumes lanes, marks attention read, and exposes failure', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const c = await auth(),
        laneId = await create(c)
      expect(await command(c, laneId, { type: 'lane.stop' })).toMatchObject({ status: 'done' })
      expect(await command(c, laneId, { type: 'prompt', message: 'Hello' })).toMatchObject({
        status: 'rejected',
        code: 'lane-stopped',
      })
      expect(await command(c, laneId, { type: 'lane.resume' })).toMatchObject({ status: 'done' })
      h.driver.emitTurn(laneId)
      expect(await command(c, laneId, { type: 'lane.markRead', upTo: 999 })).toMatchObject({
        status: 'done',
      })
      c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      await flush()
      expect(snapshots(c)[0]?.snapshot.summary).toMatchObject({ attention: 1, read: 1 })
      h.driver.failLane(laneId)
      h.driver.emitUi(laneId, {
        type: 'extension_ui_request',
        id: 'notice',
        method: 'notify',
        message: 'Unrelated activity',
      })
      await flush()
      expect(
        events(c).findLast((frame) => frame.laneId === laneId && frame.event.kind === 'summary')
          ?.event,
      ).toMatchObject({
        kind: 'summary',
        summary: { activity: 'failed' },
      })
    })
    it('recovers a slow viewer with one snapshot, without slowing the other viewer', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      await h.driver.stop()
      h = await factory({ sendQueueBytes: 6000 })
      const a = await auth(),
        laneId = await create(a),
        b = await auth({ client: otherClient })
      for (const c of [a, b]) c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      await flush()
      a.frames.length = 0
      b.frames.length = 0
      a.pause()
      let emittedMessages = 0
      for (let i = 0; i < 20; i++) {
        emittedMessages += h.driver.emitTurn(laneId).messages
        await flush()
      }
      expect(events(b).length).toBeGreaterThan(10)
      a.resume()
      await flush(50)
      expect(snapshots(a)).toHaveLength(1)
      expect(snapshots(a)[0]?.reset).toBe(true)
      expect(snapshots(a)[0]?.snapshot.messages).toHaveLength(emittedMessages)
      b.send({ type: 'unsubscribe', id: 'lane' })
      b.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      await flush()
      expect(snapshots(a)[0]?.snapshot.messages).toEqual(snapshots(b)[0]?.snapshot.messages)
      const cursor = snapshots(a)[0]?.snapshot.cursor.seq ?? -1
      h.driver.emitTurn(laneId)
      await flush()
      expect(
        events(a)
          .filter((e) => e.cursor.seq > cursor)
          .map((e) => e.cursor.seq),
      ).toEqual(
        events(b)
          .filter((e) => e.cursor.seq > cursor)
          .map((e) => e.cursor.seq),
      )
    })
    it('keeps controller ownership across disconnect and reconnect without changing its fence', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const a = await auth(),
        laneId = await create(a),
        b = await auth({ client: otherClient })
      b.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      await flush()
      a.sever()
      await flush()
      expect(events(b).find((e) => e.event.kind === 'control')?.event).toMatchObject({
        kind: 'control',
        control: { fence: 1, controller: { connected: false } },
      })
      const reconnectStart = b.frames.length
      const next = await auth()
      // Unrelated activity may follow the control change before it is inspected.
      h.driver.emitUi(laneId, {
        type: 'extension_ui_request',
        id: 'notice',
        method: 'notify',
        message: 'Reconnected',
      })
      await flush()
      expect(
        b.frames
          .slice(reconnectStart)
          .findLast(
            (frame) =>
              frame.type === 'event' && frame.laneId === laneId && frame.event.kind === 'control',
          ),
      ).toMatchObject({
        type: 'event',
        event: {
          kind: 'control',
          control: { fence: 1, controller: { connected: true } },
        },
      })
      expect(await command(next, laneId, { type: 'abort' })).toMatchObject({
        status: 'done',
        fence: 1,
      })
    })
    it('delivers a terminal receipt to each waiting socket of the same client only once', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const a = await auth(),
        laneId = await create(a),
        b = await auth(),
        requestId = h.requestId()
      const frame: ClientFrame = {
        type: 'command',
        requestId,
        laneId,
        fence: 1,
        op: { type: 'prompt', message: 'Hello' },
      }
      const before = h.driver.executions()
      a.send(frame)
      b.send({ type: 'receipt-status', requestId })
      await flush()
      expect(receipts(b, requestId).map((r) => r.status)).toEqual(['pending'])
      await flush(5)
      for (const c of [a, b])
        expect(receipts(c, requestId).filter((r) => r.status === 'done')).toHaveLength(1)
      for (const [sender, other] of [
        [a, b],
        [b, a],
      ]) {
        if (!sender || !other) throw new Error('Missing viewer')
        const oldSender = receipts(sender, requestId).length
        const oldOther = receipts(other, requestId).length
        sender.send(frame)
        sender.send({ type: 'receipt-status', requestId })
        await flush()
        expect(
          receipts(sender, requestId)
            .slice(oldSender)
            .map((r) => r.status),
        ).toEqual(['done', 'done'])
        expect(receipts(other, requestId)).toHaveLength(oldOther)
        expect(h.driver.executions()).toBe(before + 1)
      }
    })
    it('caps finished and started receipts separately, prunes by age and does not leak pruned results', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      await h.driver.stop()
      h = await factory({ receiptsKept: 1, receiptTtlMs: 20, commandDelayMs: 5 })
      const c = await auth(),
        laneId = await create(c),
        first = h.requestId(),
        second = h.requestId()
      c.send({ type: 'command', requestId: first, laneId, fence: 1, op: { type: 'abort' } })
      c.send({ type: 'command', requestId: second, laneId, fence: 1, op: { type: 'abort' } })
      await flush()
      expect(receipts(c, second)).toMatchObject([{ status: 'rejected', code: 'busy' }])
      await flush(5)
      const reconnect = await auth()
      reconnect.send({ type: 'receipt-status', requestId: first })
      await flush()
      expect(receipts(reconnect, first)).toMatchObject([{ status: 'done' }])
      // Count pruning breaks same-millisecond ties by request id, not admission order.
      await flush(1)
      await command(c, laneId, { type: 'lane.markRead', upTo: 0 })
      const lookup = await auth()
      lookup.send({ type: 'receipt-status', requestId: first })
      await flush()
      expect(receipts(lookup, first)).toEqual([{ requestId: first, status: 'unknown' }])
      const latest = await command(c, laneId, { type: 'abort' })
      await flush(20)
      const beforeExpiry = await auth()
      beforeExpiry.send({ type: 'receipt-status', requestId: latest.requestId })
      await flush()
      expect(receipts(beforeExpiry, latest.requestId)).toEqual([latest])
      await flush(1)
      lookup.send({ type: 'receipt-status', requestId: latest.requestId })
      await flush()
      expect(receipts(lookup, latest.requestId)).toEqual([
        { requestId: latest.requestId, status: 'unknown' },
      ])
    })
    it('keeps started receipts past the TTL and does not extend terminal retention on reads', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      await h.driver.stop()
      h = await factory({ receiptTtlMs: 20, commandDelayMs: 25 })
      const c = await auth(),
        laneId = await create(c),
        requestId = h.requestId()
      c.send({ type: 'command', requestId, laneId, fence: 1, op: { type: 'abort' } })
      await flush(21)
      const pending = await auth()
      pending.send({ type: 'receipt-status', requestId })
      await flush()
      expect(receipts(pending, requestId)).toEqual([{ requestId, status: 'pending' }])
      await flush(4)
      const terminal = receipts(c, requestId).at(-1)
      expect(terminal?.status).toBe('done')
      await flush(20)
      const boundary = await auth()
      boundary.send({ type: 'receipt-status', requestId })
      await flush()
      expect(receipts(boundary, requestId)).toEqual([terminal])
      await flush(1)
      const expired = await auth()
      expired.send({ type: 'receipt-status', requestId })
      await flush()
      expect(receipts(expired, requestId)).toEqual([{ requestId, status: 'unknown' }])
    })
    it('gates read operations and removes subscriptions when renewal drops read authority', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      const c = await auth(),
        laneId = await create(c),
        denied = await auth({ client: otherClient, caps: [] })
      denied.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
      denied.send({ type: 'call', id: 'repositories', method: 'host.repositories' })
      await flush()
      expect(denied.frames).toContainEqual({
        type: 'subscribe-failed',
        id: 'all',
        code: 'forbidden',
      })
      expect(denied.frames.at(-1)).toMatchObject({
        type: 'result',
        ok: false,
        error: { code: 'forbidden' },
      })
      c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      await flush()
      c.send({ type: 'auth', grant: h.mintGrant({ caps: [] }) })
      await flush()
      c.frames.length = 0
      h.driver.emitTurn(laneId)
      await flush()
      expect(c.frames).toEqual([])
    })
    it('bounds replay by bytes and attention by count, resetting when replay is unavailable', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      await h.driver.stop()
      h = await factory({ replayBytes: 1, attentionReplay: 1 })
      const c = await auth(),
        laneId = await create(c)
      c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      c.send({ type: 'subscribe', id: 'all', topic: 'lanes' })
      await flush()
      const lanes = c.frames.find((f) => f.type === 'lanes' && f.id === 'all')
      if (!lanes || lanes.type !== 'lanes') throw new Error('Missing lanes cursor')
      const start = snapshots(c)[0]
      if (!start) throw new Error('Missing snapshot')
      h.driver.emitTurn(laneId)
      h.driver.emitTurn(laneId)
      await flush()
      c.send({ type: 'unsubscribe', id: 'lane' })
      c.send({ type: 'unsubscribe', id: 'all' })
      c.send({
        type: 'subscribe',
        id: 'resume',
        topic: 'lane',
        laneId,
        after: start.snapshot.cursor,
      })
      c.send({ type: 'subscribe', id: 'attention', topic: 'lanes', after: lanes.cursor })
      await flush()
      expect(snapshots(c).at(-1)?.reset).toBe(true)
      expect(c.frames.filter((f) => f.type === 'attention' && f.id === 'attention')).toHaveLength(1)
    })
    it('replaces an oversize event with a reset, and ends only an oversize lanes subscription', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      await h.driver.stop()
      h = await factory({ outboundFrameBytes: 1800 })
      const c = await auth(),
        laneId = await create(c)
      c.send({ type: 'subscribe', id: 'baseline', topic: 'lanes' })
      await flush()
      const lanes = c.frames.find((f) => f.type === 'lanes' && f.id === 'baseline')
      if (!lanes || lanes.type !== 'lanes') throw new Error('Missing lanes cursor')
      c.send({ type: 'unsubscribe', id: 'baseline' })
      c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
      await flush()
      h.driver.emitUi(laneId, {
        type: 'extension_ui_request',
        id: 'notice',
        method: 'notify',
        message: 'x'.repeat(2000),
      })
      await flush()
      expect(snapshots(c).at(-1)?.reset).toBe(true)
      expect(
        events(c).some((f) => f.event.kind === 'pi' && f.event.push.kind === 'extension-ui'),
      ).toBe(false)
      await create(c)
      await create(c)
      await create(c)
      h.driver.emitTurn(laneId)
      c.send({ type: 'subscribe', id: 'all', topic: 'lanes', after: lanes.cursor })
      await flush()
      expect(c.frames).toContainEqual({ type: 'subscribe-failed', id: 'all', code: 'too-large' })
      expect(c.frames.filter((f) => f.type === 'attention' && f.id === 'all')).toEqual([])
      expect(c.socket.isOpen()).toBe(true)
    })
    it.for([false, true])(
      'stops buffered replay after an oversized event (oversize reset: %s)',
      async (oversizeReset, t) => {
        if (lacks('sessions.read', 'sessions.control'))
          t.skip('requires sessions.read and sessions.control')
        await h.driver.stop()
        h = await factory({ outboundFrameBytes: 1800 })
        const c = await auth(),
          laneId = await create(c)
        c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId })
        await flush()
        const start = snapshots(c)[0]
        if (!start) throw new Error('Missing snapshot')
        c.send({ type: 'unsubscribe', id: 'lane' })
        await flush()
        h.driver.emitUi(laneId, {
          type: 'extension_ui_request',
          id: 'large',
          method: 'notify',
          message: 'x'.repeat(2000),
        })
        h.driver.emitUi(laneId, {
          type: 'extension_ui_request',
          id: 'small',
          method: 'notify',
          message: 'small',
        })
        if (oversizeReset)
          h.driver.emitUi(laneId, {
            type: 'extension_ui_request',
            id: 'status',
            method: 'setStatus',
            statusKey: 'large',
            statusText: 'x'.repeat(2000),
          })
        c.frames.length = 0
        c.send({
          type: 'subscribe',
          id: 'replay',
          topic: 'lane',
          laneId,
          after: start.snapshot.cursor,
        })
        await flush()
        if (oversizeReset) {
          expect(c.frames).toEqual([{ type: 'subscribe-failed', id: 'replay', code: 'too-large' }])
        } else {
          expect(snapshots(c)).toHaveLength(1)
          expect(snapshots(c)[0]?.reset).toBe(true)
          expect(snapshots(c)[0]?.snapshot.cursor.seq).toBeGreaterThan(start.snapshot.cursor.seq)
        }
        expect(events(c, 'replay')).toEqual([])
        h.driver.emitUi(laneId, {
          type: 'extension_ui_request',
          id: 'later',
          method: 'notify',
          message: 'later',
        })
        await flush()
        if (oversizeReset) expect(events(c, 'replay')).toEqual([])
        else {
          const resetSeq = snapshots(c)[0]?.snapshot.cursor.seq
          if (resetSeq === undefined) throw new Error('Missing reset cursor')
          expect(events(c, 'replay').map((f) => f.cursor.seq)).toEqual([resetSeq + 1])
        }
        expect(c.socket.isOpen()).toBe(true)
      },
    )
    it('caps connections per client without affecting existing sockets', async () => {
      await h.driver.stop()
      h = await factory({ connectionsPerClient: 1 })
      const a = await auth(),
        b = client()
      b.send({ type: 'auth', grant: h.mintGrant(), challenge })
      await flush()
      expect(b.closed).toEqual([4429])
      expect(a.socket.isOpen()).toBe(true)
    })
    it('fails only an oversize subscription or call, leaving another lane streaming', async (t) => {
      if (lacks('sessions.read', 'sessions.control'))
        t.skip('requires sessions.read and sessions.control')
      await h.driver.stop()
      h = await factory({ outboundFrameBytes: 1800 })
      const c = await auth(),
        large = await create(c),
        small = await create(c)
      for (let i = 0; i < 30; i++) {
        h.driver.emitTurn(large)
        await flush()
      }
      c.send({ type: 'subscribe', id: 'large', topic: 'lane', laneId: large })
      c.send({ type: 'subscribe', id: 'lane', topic: 'lane', laneId: small })
      c.send({ type: 'call', id: 'messages', method: 'lane.messages', params: { laneId: large } })
      await flush()
      expect(c.frames).toContainEqual({ type: 'subscribe-failed', id: 'large', code: 'too-large' })
      expect(c.frames.find((f) => f.type === 'result' && f.id === 'messages')).toMatchObject({
        ok: false,
        error: { code: 'too-large' },
      })
      h.driver.emitTurn(small)
      await flush()
      expect(events(c).length).toBeGreaterThan(0)
      expect(c.socket.isOpen()).toBe(true)
    })
  })
}
