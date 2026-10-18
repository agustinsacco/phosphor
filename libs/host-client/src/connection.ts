import type { TerminalFrame } from '@phosphor/shared/host-protocol-terminals'
import { browserCrypto, type IdentityCrypto } from './crypto'
import { createHandshake } from './handshake'
import { createRequests, type CommandResult } from './requests'
export type { CommandResult, NotSent } from './requests'
import { isEndpoint, type GrantIssueResponse } from '@phosphor/shared/control-api'
import {
  HOST_LIMITS,
  parseHostFrame,
  parseClientFrame,
  utf8Length,
  type ClientFrame,
  type FrameSocket,
  type HostFrame,
  type LaneOp,
  type LaneSummary,
  type StreamCursor,
} from '@phosphor/shared/host-protocol'
import type { HostConnectionView } from '@phosphor/shared/ipc'
import type { TraceLog } from './ports'

export type HostConnectionSnapshot = Omit<HostConnectionView, 'lanes'> & { lanes: LaneSummary[] }

export type LaneFrame = Extract<HostFrame, { type: 'snapshot' | 'event' | 'subscribe-failed' }>
export function hostEndpoint(value: unknown): value is string {
  return isEndpoint(value) && new URL(value).hostname.endsWith('.ts.net')
}
export function createHostConnection(ports: {
  identity?: IdentityCrypto
  hostId: string
  endpoint: string | null
  endpointAllowed?: (value: unknown) => boolean
  unrefTimer?: (timer: ReturnType<typeof setTimeout>) => void
  socket: (url: string) => Promise<FrameSocket>
  grant: () => Promise<GrantIssueResponse>
  clearGrant: () => void
  changed: () => void
  onRoutinesChanged?: () => void
  onAttention?: (event: Extract<HostFrame, { type: 'attention' }>['event']) => void
  disabled?: () => void
  log?: TraceLog
  /** Every frame sent or received, for the metadata-only traffic log. */
  traffic?: (direction: 'in' | 'out', frame: ClientFrame | HostFrame, bytes: number) => void
  now?: () => number
  random?: () => number
}) {
  const identity = ports.identity ?? browserCrypto
  const now = ports.now ?? Date.now
  const log = ports.log ?? (() => {})
  let view: HostConnectionSnapshot = {
    state: 'connecting',
    connectionToken: identity.randomUUID(),
    capabilities: [],
    repositories: [],
    lanes: [],
  }
  let socket: FrameSocket | null = null,
    stopped = false,
    attempt = 0,
    generation = 0
  let trace = ''
  let challenge = '',
    key = '',
    started = 0,
    lastPong = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let renewalTimeout: ReturnType<typeof setTimeout> | undefined
  const requests = createRequests({
    now,
    write,
    later,
    changed: ports.changed,
    canReplay: () => !stopped && !!socket && view.state === 'ready',
    unrefTimer: ports.unrefTimer,
    transportFailed: () => socket?.close(1000, 'Transport failed'),
  })
  const watches = new Map<
    string,
    { laneId: string; cursor?: StreamCursor; listener: (frame: LaneFrame) => void }
  >()
  let runtimeEpoch = ''
  const terminals = new Map<
    string,
    {
      terminalId: string
      listener: (f: TerminalFrame | Extract<HostFrame, { type: 'subscribe-failed' }>) => void
    }
  >()
  const inputs = new Map<string, { seq: number; resolve: (accepted: boolean) => void }>()
  function dropInputs() {
    for (const input of inputs.values()) input.resolve(false)
    inputs.clear()
  }
  function subscribeTerminal(id: string, terminalId: string) {
    if (!write({ type: 'subscribe', topic: 'terminal', id, terminalId }))
      socket?.close(1000, 'Transport failed')
  }
  const attention: Extract<HostFrame, { type: 'attention' }>[] = []
  function later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
    return timer
  }
  function update(next: Partial<HostConnectionSnapshot>) {
    view = { ...view, ...next }
    ports.changed()
  }
  function write(frame: ClientFrame): boolean {
    if (view.state !== 'ready' && frame.type !== 'auth') return false
    const text = JSON.stringify(frame)
    if (
      !parseClientFrame(text).ok ||
      !socket?.isOpen() ||
      utf8Length(text) > HOST_LIMITS.inboundFrameBytes ||
      socket.bufferedBytes() + utf8Length(text) > HOST_LIMITS.sendQueueBytes
    )
      return false
    try {
      socket.send(text)
    } catch {
      socket.close(1000, 'Transport failed')
      return false
    }
    observe('out', frame, text)
    return true
  }
  /** The traffic log is diagnostic: it must never affect the connection. */
  function observe(direction: 'in' | 'out', frame: ClientFrame | HostFrame, text: string) {
    try {
      ports.traffic?.(direction, frame, utf8Length(text))
    } catch {
      /* Ignored on purpose. */
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
            trace: identity.randomHex(8),
          }
        : { type: 'subscribe', id, topic: 'lanes', after, trace: identity.randomHex(8) },
    )
    if (!sent) socket?.close(1000, 'Transport failed')
  }
  function finish() {
    stopped = true
    generation++
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    try {
      socket?.close(1000, 'Closed')
    } catch {
      log('hosts', 'close_failed')
    }
    socket = null
    requests.close()
    watches.clear()
    terminals.clear()
    dropInputs()
  }
  function failed(code: number, error?: string) {
    if (stopped) return
    if (
      error &&
      !['grant-refused', 'account-disabled', 'too-many-requests', 'signed-out'].includes(error)
    )
      error = 'offline'
    generation++
    dropInputs()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    socket = null
    requests.disconnect(code)
    log('hosts', 'closed', { hostId: ports.hostId, code, ms: Math.max(0, now() - started) })
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
              if (!write({ type: 'auth', grant: g.grant, trace }))
                socket?.close(1000, 'Transport failed')
              renewalTimeout = later(
                () => socket?.close(4401, 'Renewal timeout'),
                HOST_LIMITS.authTimeoutMs,
              )
            }
          })
          .catch((error) => {
            if (epoch === generation && !stopped) {
              socket?.close(1000, 'Renewal failed')
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
        socket?.close(1000, 'Ping timeout')
        return
      }
      if (!write({ type: 'ping', at: now() })) socket?.close(1000, 'Transport failed')
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
    observe('in', f, text)
    if (view.state !== 'ready') {
      if (f.type !== 'ready') {
        socket?.close(4400, 'Expected ready')
        return
      }
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      attempt = 0
      lastPong = now()
      runtimeEpoch = f.hello.runtimeEpoch
      requests.prepareReplay()
      update({
        state: 'ready',
        lastError: undefined,
        hostVersion: f.hello.hostVersion,
        configurationSupported: f.settings === true,
        capabilities: [...f.capabilities],
      })
      if (stopped) return
      log('hosts', 'ready', {
        hostId: ports.hostId,
        connectionId: f.connectionId,
        version: f.hello.hostVersion,
        caps: f.capabilities,
      })
      subscribe('lanes', undefined, view.cursor)
      for (const [id, w] of watches) subscribe(id, w.laneId, w.cursor)
      for (const [id, w] of terminals) subscribeTerminal(id, w.terminalId)
      requests.flushReplay()
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
      if (f.capabilities) update({ capabilities: [...f.capabilities] })
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
    } else if (f.type === 'routines-changed' && f.id === 'lanes') {
      if (!view.cursor || view.cursor.epoch !== f.cursor.epoch || f.cursor.seq <= view.cursor.seq)
        return
      if (f.cursor.seq !== view.cursor.seq + 1) subscribe('lanes')
      // Only the routines surface changed; do not invalidate every Host query.
      view = { ...view, cursor: f.cursor }
      ports.onRoutinesChanged?.()
    } else if ((f.type === 'lanes-delta' || f.type === 'attention') && f.id === 'lanes') {
      if (!view.cursor || view.cursor.epoch !== f.cursor.epoch) return
      if (f.type === 'attention') {
        if (!attention.some((a) => a.event.id === f.event.id)) {
          attention.push(f)
          ports.onAttention?.(f.event)
        }
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
    } else if (f.type === 'terminal.ack') {
      const input = inputs.get(f.terminalId)
      if (input?.seq === f.seq) {
        inputs.delete(f.terminalId)
        input.resolve(f.accepted)
      }
    } else if (
      f.type === 'terminal.reset' ||
      f.type === 'terminal.output' ||
      f.type === 'terminal.exit'
    ) {
      const w = terminals.get(f.id)
      if (w?.terminalId === f.terminalId) w.listener(f)
    } else if (f.type === 'subscribe-failed' && terminals.has(f.id)) {
      terminals.get(f.id)?.listener(f)
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
        if (f.type === 'snapshot') {
          update({ lanes: view.lanes.map((l) => (l.laneId === f.laneId ? f.snapshot.summary : l)) })
        } else if (
          f.type === 'event' &&
          (f.event.kind === 'control' || f.event.kind === 'summary')
        ) {
          const event = f.event
          update({
            lanes: view.lanes.map((l) =>
              l.laneId !== f.laneId
                ? l
                : event.kind === 'summary'
                  ? event.summary
                  : { ...l, control: event.control },
            ),
          })
        }
        w.listener(f.type === 'snapshot' ? { ...f, reset } : f)
      } else if (f.type === 'subscribe-failed' && f.id === 'lanes') update({ lastError: f.code })
    } else if (f.type === 'receipt' && f.receipt.status !== 'pending') {
      const receiptOp = requests.receipt(f.receipt)
      if (receiptOp && !receiptOp.startsWith('terminal.'))
        log('hosts', 'receipt', {
          hostId: ports.hostId,
          requestId: f.receipt.requestId,
          status: f.receipt.status,
        })
    } else if (f.type === 'result') requests.result(f)
  }
  async function connect() {
    if (stopped) return
    if (!(ports.endpointAllowed ?? hostEndpoint)(ports.endpoint) || !ports.endpoint) {
      update({ state: 'no-address' })
      finish()
      return
    }
    const epoch = ++generation
    update({ connectionToken: identity.randomUUID() })
    started = now()
    trace = identity.randomHex(8)
    log('hosts', 'connect', { hostId: ports.hostId, trace })
    try {
      const grant = await ports.grant()
      if (stopped || generation !== epoch) return
      if (grant.host.id !== ports.hostId || grant.host.endpoint !== ports.endpoint)
        throw new Error('grant-refused')
      const opened = await ports.socket(`${ports.endpoint.replace('https:', 'wss:')}/v1/stream`)
      if (stopped || generation !== epoch) {
        opened.close(1000, 'Closed')
        return
      }
      socket = opened
      key = grant.host.publicKey
      challenge = identity.randomHex(32)
      const handshake = createHandshake({
        hostId: ports.hostId,
        key,
        challenge,
        identity,
        current: () => !stopped && generation === epoch && socket === opened && opened.isOpen(),
        receive,
        refuse: (unsupported) => {
          log('hosts', unsupported ? 'unsupported-crypto' : 'wrong-machine', {
            hostId: ports.hostId,
          })
          update({
            state: unsupported ? 'unsupported' : 'wrong-machine',
            lastError: unsupported ? 'ed25519-unsupported' : 'not-the-enrolled-machine',
          })
          finish()
        },
      })
      opened.onMessage(handshake.receive)
      opened.onClose((code) => {
        if (socket === opened) failed(code)
      })
      later(() => opened.close(4401, 'Auth timeout'), HOST_LIMITS.authTimeoutMs)
      if (!write({ type: 'auth', grant: grant.grant, challenge, trace }))
        opened.close(1000, 'Transport failed')
    } catch (error) {
      if (!stopped && generation === epoch)
        failed(0, error instanceof Error ? error.message : 'offline')
    }
  }
  void connect()
  return {
    snapshot: () => structuredClone(view),
    incarnation: () => ({ generation, runtimeEpoch }),
    watchTerminal(
      terminalId: string,
      listener: (f: TerminalFrame | Extract<HostFrame, { type: 'subscribe-failed' }>) => void,
    ) {
      if (stopped || watches.size + terminals.size >= HOST_LIMITS.subscriptionsPerConnection - 1)
        throw new Error('Subscription unavailable.')
      const id = identity.randomUUID()
      terminals.set(id, { terminalId, listener })
      if (view.state === 'ready') subscribeTerminal(id, terminalId)
      return {
        reset: () => subscribeTerminal(id, terminalId),
        close: () => {
          terminals.delete(id)
          if (view.state === 'ready') write({ type: 'unsubscribe', id })
        },
      }
    },
    input(terminalId: string, seq: number, data: string): Promise<boolean> {
      if (stopped || view.state !== 'ready' || inputs.has(terminalId)) return Promise.resolve(false)
      return new Promise((resolve) => {
        const timer = later(() => {
          const pending = inputs.get(terminalId)
          if (pending?.seq === seq) {
            inputs.delete(terminalId)
            pending.resolve(false)
          }
        }, 5000)
        const settle = (accepted: boolean) => {
          clearTimeout(timer)
          timers.delete(timer)
          resolve(accepted)
        }
        inputs.set(terminalId, { seq, resolve: settle })
        ports.unrefTimer?.(timer)
        if (!write({ type: 'terminal.input', terminalId, seq, data })) {
          inputs.delete(terminalId)
          settle(false)
          socket?.close(1000, 'Transport failed')
        }
      })
    },
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
      const requestId = identity.randomUUID()
      const frame: Extract<ClientFrame, { type: 'command' }> = {
        type: 'command',
        requestId,
        op: structuredClone(op),
        laneId,
        fence,
        trace: identity.randomHex(8),
      }
      const reason =
        utf8Length(JSON.stringify(frame)) > HOST_LIMITS.inboundFrameBytes
          ? 'too-large'
          : requests.replaying()
            ? 'not-connected'
            : requests.full()
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
          socket?.close(1000, 'Transport failed')
          return
        }
        requests.track(frame, resolve)
      })
    },
    call(method: string, params?: unknown): Promise<Extract<HostFrame, { type: 'result' }>> {
      return requests.call(
        identity.randomUUID(),
        view.state === 'ready',
        method,
        params,
        identity.randomHex(8),
      )
    },
    watchLane(laneId: string, listener: (frame: LaneFrame) => void) {
      if (stopped || watches.size >= HOST_LIMITS.subscriptionsPerConnection - 1)
        throw new Error('Subscription unavailable.')
      const id = identity.randomUUID()
      watches.set(id, { laneId, listener })
      if (view.state === 'ready') subscribe(id, laneId)
      return () => {
        watches.delete(id)
        if (view.state === 'ready') write({ type: 'unsubscribe', id })
      }
    },
  }
}
