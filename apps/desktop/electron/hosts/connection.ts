import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { isEndpoint, type GrantIssueResponse } from '@shared/control-api'
import {
  HOST_LIMITS,
  helloProofMessage,
  parseHostFrame,
  utf8Length,
  type ClientFrame,
  type FrameSocket,
  type HostFrame,
  type LaneOp,
  type Receipt,
  type StreamCursor,
} from '@shared/host-protocol'
import type { HostConnectionView } from '@shared/ipc'
import type { TraceLog } from '../control/observations'

export type NotSent = {
  requestId: string
  status: 'not-sent'
  reason: 'too-large' | 'too-many-pending' | 'not-connected' | 'closed'
}
export type CommandResult = Receipt | NotSent
export type LaneFrame = Extract<HostFrame, { type: 'snapshot' | 'event' | 'subscribe-failed' }>
export function hostEndpoint(value: unknown): value is string {
  return isEndpoint(value) && new URL(value).hostname.endsWith('.ts.net')
}
export function createHostConnection(ports: {
  hostId: string
  endpoint: string | null
  socket: (url: string) => Promise<FrameSocket>
  grant: () => Promise<GrantIssueResponse>
  clearGrant: () => void
  changed: () => void
  disabled?: () => void
  log?: TraceLog
  now?: () => number
  random?: () => number
}) {
  const now = ports.now ?? Date.now
  const log = ports.log ?? (() => {})
  let view: HostConnectionView = {
    state: 'connecting',
    capabilities: [],
    repositories: [],
    lanes: [],
  }
  let socket: FrameSocket | null = null,
    stopped = false,
    attempt = 0,
    generation = 0
  let challenge = '',
    key = '',
    started = 0,
    lastPong = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let renewalTimeout: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<
    string,
    {
      frame: Extract<ClientFrame, { type: 'command' }>
      at: number
      statusOnly: boolean
      resolve: (r: CommandResult) => void
    }
  >()
  const calls = new Map<
    string,
    {
      resolve: (f: Extract<HostFrame, { type: 'result' }>) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const watches = new Map<
    string,
    { laneId: string; cursor?: StreamCursor; listener: (frame: LaneFrame) => void }
  >()
  const attention: Extract<HostFrame, { type: 'attention' }>[] = []
  function later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
    return timer
  }
  function update(next: Partial<HostConnectionView>) {
    view = { ...view, ...next }
    ports.changed()
  }
  function write(frame: ClientFrame): boolean {
    const text = JSON.stringify(frame)
    if (
      !socket?.isOpen() ||
      utf8Length(text) > HOST_LIMITS.inboundFrameBytes ||
      socket.bufferedBytes() + utf8Length(text) > HOST_LIMITS.sendQueueBytes
    )
      return false
    try {
      socket.send(text)
      return true
    } catch {
      socket.close(1001, 'Transport failed')
      return false
    }
  }
  function subscribe(id: string, laneId?: string, after?: StreamCursor) {
    const sent = write(
      laneId
        ? {
            type: 'subscribe',
            id,
            topic: 'lane',
            laneId,
            after,
            trace: randomBytes(8).toString('hex'),
          }
        : { type: 'subscribe', id, topic: 'lanes', after, trace: randomBytes(8).toString('hex') },
    )
    if (!sent) socket?.close(1001, 'Transport failed')
  }
  function finish() {
    stopped = true
    generation++
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    socket?.close(1001, 'Closed')
    socket = null
    for (const [requestId, p] of pending) p.resolve({ requestId, status: 'unknown' })
    pending.clear()
    for (const [id, c] of calls)
      c.resolve({
        type: 'result',
        id,
        ok: false,
        error: { code: 'internal', message: 'Connection closed.' },
      })
    calls.clear()
    watches.clear()
  }
  function failed(code: number, error?: string) {
    if (stopped) return
    if (
      error &&
      !['grant-refused', 'account-disabled', 'too-many-requests', 'signed-out'].includes(error)
    )
      error = 'offline'
    generation++
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    socket = null
    for (const [id, c] of calls)
      c.resolve({
        type: 'result',
        id,
        ok: false,
        error: { code: 'internal', message: 'Connection closed.' },
      })
    calls.clear()
    log('hosts', 'closed', { hostId: ports.hostId, code, ms: Math.max(0, now() - started) })
    if (code === 4400 || code === 1009) for (const p of pending.values()) p.statusOnly = true
    if (code === 4401) ports.clearGrant()
    if (
      code === 4403 ||
      code === 4409 ||
      error === 'grant-refused' ||
      error === 'account-disabled'
    ) {
      update({
        state: code === 4409 ? 'unsupported' : 'reconnecting',
        lastError: error ?? 'forbidden',
      })
      finish()
      if (error === 'account-disabled') ports.disabled?.()
      return
    }
    update({ state: 'reconnecting', lastError: error ?? 'disconnected' })
    const delay =
      Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6)) * (ports.random ?? Math.random)()
    later(
      () => {
        void connect()
      },
      Math.max(code === 4429 || error === 'too-many-requests' ? 30_000 : 0, delay),
    )
  }
  function renew(expiresAt: string) {
    later(
      () => {
        const epoch = generation
        void ports
          .grant()
          .then((g) => {
            if (!stopped && epoch === generation) {
              if (!write({ type: 'auth', grant: g.grant })) socket?.close(1001, 'Transport failed')
              renewalTimeout = later(
                () => socket?.close(4401, 'Renewal timeout'),
                HOST_LIMITS.authTimeoutMs,
              )
            }
          })
          .catch((error) => {
            if (epoch === generation && !stopped) {
              socket?.close(1001, 'Renewal failed')
              failed(0, error instanceof Error ? error.message : 'offline')
            }
          })
      },
      Math.max(1000, Date.parse(expiresAt) - now() - HOST_LIMITS.renewBeforeSec * 1000),
    )
  }
  function beat() {
    later(() => {
      if (now() - lastPong >= 2 * HOST_LIMITS.pingIntervalMs) {
        socket?.close(1001, 'Ping timeout')
        return
      }
      if (!write({ type: 'ping', at: now() })) socket?.close(1001, 'Transport failed')
      beat()
    }, HOST_LIMITS.pingIntervalMs)
  }
  function receive(text: string) {
    const parsed = parseHostFrame(text)
    if (!parsed.ok) {
      socket?.close(4400, 'Bad frame')
      return
    }
    const f = parsed.value
    if (view.state !== 'ready') {
      if (f.type !== 'ready') {
        socket?.close(4400, 'Expected ready')
        return
      }
      let valid = false
      try {
        valid =
          f.hello.hostId === ports.hostId &&
          verify(
            null,
            Buffer.from(helloProofMessage(f.hello.hostId, f.hello.runtimeEpoch, challenge)),
            createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' }),
            Buffer.from(f.proof, 'base64url'),
          )
      } catch {
        /* Fail closed. */
      }
      if (!valid) {
        log('hosts', 'wrong-machine', { hostId: ports.hostId })
        update({ state: 'wrong-machine', lastError: 'not-the-enrolled-machine' })
        finish()
        return
      }
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      attempt = 0
      lastPong = now()
      update({
        state: 'ready',
        lastError: undefined,
        hostVersion: f.hello.hostVersion,
        capabilities: [...f.capabilities],
      })
      log('hosts', 'ready', {
        hostId: ports.hostId,
        connectionId: f.connectionId,
        version: f.hello.hostVersion,
        caps: f.capabilities,
      })
      subscribe('lanes', undefined, view.cursor)
      for (const [id, w] of watches) subscribe(id, w.laneId, w.cursor)
      for (const [requestId, p] of pending)
        write(
          p.statusOnly || now() - p.at >= 60_000 ? { type: 'receipt-status', requestId } : p.frame,
        )
      renew(f.grantExpiresAt)
      beat()
      return
    }
    if (f.type === 'ready') {
      socket?.close(4400, 'Duplicate ready')
      return
    }
    if (f.type === 'auth-renewed') {
      if (!renewalTimeout) {
        socket?.close(4400, 'Unexpected renewal')
        return
      }
      if (renewalTimeout) {
        clearTimeout(renewalTimeout)
        timers.delete(renewalTimeout)
      }
      renewalTimeout = undefined
      renew(f.grantExpiresAt)
    } else if (f.type === 'pong') lastPong = now()
    else if (f.type === 'lanes' && f.id === 'lanes') {
      if (view.cursor?.epoch !== f.cursor.epoch) attention.length = 0
      update({
        repositories: [...f.repositories],
        lanes: [...f.lanes],
        cursor: {
          epoch: f.cursor.epoch,
          seq:
            view.cursor?.epoch === f.cursor.epoch
              ? Math.max(view.cursor.seq, f.cursor.seq)
              : f.cursor.seq,
        },
      })
    } else if ((f.type === 'lanes-delta' || f.type === 'attention') && f.id === 'lanes') {
      if (!view.cursor || view.cursor.epoch !== f.cursor.epoch) return
      if (f.type === 'attention') {
        if (!attention.some((a) => a.event.id === f.event.id)) attention.push(f)
        attention.sort((a, b) => a.cursor.seq - b.cursor.seq)
        if (attention.length > 50) attention.shift()
        update({ cursor: { epoch: f.cursor.epoch, seq: Math.max(view.cursor.seq, f.cursor.seq) } })
      } else {
        if (f.cursor.seq <= view.cursor.seq) return
        if (f.cursor.seq !== view.cursor.seq + 1) {
          subscribe('lanes')
          return
        }
        const lanes = new Map(view.lanes.map((l) => [l.laneId, l]))
        for (const id of f.remove) lanes.delete(id)
        for (const l of f.upsert) lanes.set(l.laneId, l)
        if (lanes.size > HOST_LIMITS.lanesPerHost) {
          socket?.close(4400, 'Lane limit')
          return
        }
        update({ lanes: [...lanes.values()], cursor: f.cursor })
      }
    } else if (f.type === 'snapshot' || f.type === 'event' || f.type === 'subscribe-failed') {
      const w = watches.get(f.id)
      if (w && (f.type === 'subscribe-failed' || f.laneId === w.laneId)) {
        if (
          f.type === 'event' &&
          (!w.cursor || w.cursor.epoch !== f.cursor.epoch || f.cursor.seq !== w.cursor.seq + 1)
        ) {
          subscribe(f.id, w.laneId)
          return
        }
        const reset =
          f.type === 'snapshot' &&
          (f.reset || (!!w.cursor && w.cursor.epoch !== f.snapshot.cursor.epoch))
        if (f.type !== 'subscribe-failed')
          w.cursor = f.type === 'snapshot' ? f.snapshot.cursor : f.cursor
        w.listener(f.type === 'snapshot' ? { ...f, reset } : f)
      } else if (f.type === 'subscribe-failed' && f.id === 'lanes') update({ lastError: f.code })
    } else if (f.type === 'receipt' && f.receipt.status !== 'pending') {
      pending.get(f.receipt.requestId)?.resolve(f.receipt)
      pending.delete(f.receipt.requestId)
      log('hosts', 'receipt', {
        hostId: ports.hostId,
        requestId: f.receipt.requestId,
        status: f.receipt.status,
      })
    } else if (f.type === 'result') {
      const c = calls.get(f.id)
      if (c) {
        clearTimeout(c.timer)
        timers.delete(c.timer)
        calls.delete(f.id)
        c.resolve(f)
      }
    }
  }
  async function connect() {
    if (stopped) return
    if (!hostEndpoint(ports.endpoint)) {
      update({ state: 'no-address' })
      finish()
      return
    }
    const epoch = ++generation
    started = now()
    log('hosts', 'connect', { hostId: ports.hostId, trace: randomBytes(8).toString('hex') })
    try {
      const grant = await ports.grant()
      if (stopped || generation !== epoch) return
      if (grant.host.id !== ports.hostId || grant.host.endpoint !== ports.endpoint)
        throw new Error('grant-refused')
      const opened = await ports.socket(`${ports.endpoint.replace('https:', 'wss:')}/v1/stream`)
      if (stopped || generation !== epoch) {
        opened.close(1001, 'Closed')
        return
      }
      socket = opened
      key = grant.host.publicKey
      challenge = randomBytes(32).toString('hex')
      opened.onMessage((text) => {
        if (socket === opened) receive(text)
      })
      opened.onClose((code) => {
        if (socket === opened) failed(code)
      })
      later(() => opened.close(4401, 'Auth timeout'), HOST_LIMITS.authTimeoutMs)
      if (!write({ type: 'auth', grant: grant.grant, challenge }))
        opened.close(1001, 'Transport failed')
    } catch (error) {
      if (!stopped && generation === epoch)
        failed(0, error instanceof Error ? error.message : 'offline')
    }
  }
  void connect()
  return {
    snapshot: () => structuredClone(view),
    attention: () => structuredClone(attention),
    close() {
      attention.length = 0
      challenge = ''
      key = ''
      update({
        state: 'signed-out',
        capabilities: [],
        repositories: [],
        lanes: [],
        cursor: undefined,
      })
      finish()
    },
    send(op: LaneOp, laneId?: string, fence?: number): Promise<CommandResult> {
      const requestId = randomUUID()
      const frame: Extract<ClientFrame, { type: 'command' }> = {
        type: 'command',
        requestId,
        op: structuredClone(op),
        laneId,
        fence,
        trace: randomBytes(8).toString('hex'),
      }
      const reason =
        utf8Length(JSON.stringify(frame)) > HOST_LIMITS.inboundFrameBytes
          ? 'too-large'
          : pending.size >= HOST_LIMITS.pendingCommandsPerConnection
            ? 'too-many-pending'
            : stopped
              ? 'closed'
              : view.state !== 'ready'
                ? 'not-connected'
                : undefined
      if (reason) return Promise.resolve({ requestId, status: 'not-sent', reason })
      return new Promise((resolve) => {
        if (!write(frame)) {
          resolve({ requestId, status: 'not-sent', reason: 'not-connected' })
          socket?.close(1001, 'Transport failed')
          return
        }
        pending.set(requestId, { frame, at: now(), statusOnly: false, resolve })
      })
    },
    call(method: string, params?: unknown): Promise<Extract<HostFrame, { type: 'result' }>> {
      const id = randomUUID()
      if (calls.size >= HOST_LIMITS.pendingCommandsPerConnection || view.state !== 'ready')
        return Promise.resolve({
          type: 'result',
          id,
          ok: false,
          error: { code: 'internal', message: 'Connection unavailable.' },
        })
      return new Promise((resolve) => {
        const timer = later(() => {
          calls.delete(id)
          resolve({
            type: 'result',
            id,
            ok: false,
            error: { code: 'internal', message: 'Query timed out.' },
          })
        }, 30_000)
        calls.set(id, { resolve, timer })
        if (!write({ type: 'call', id, method, params, trace: randomBytes(8).toString('hex') }))
          socket?.close(1001, 'Transport failed')
      })
    },
    watchLane(laneId: string, listener: (frame: LaneFrame) => void) {
      if (stopped || watches.size >= HOST_LIMITS.subscriptionsPerConnection - 1)
        throw new Error('Subscription unavailable.')
      const id = randomUUID()
      watches.set(id, { laneId, listener })
      if (view.state === 'ready') subscribe(id, laneId)
      return () => {
        watches.delete(id)
        if (view.state === 'ready') write({ type: 'unsubscribe', id })
      }
    },
  }
}
