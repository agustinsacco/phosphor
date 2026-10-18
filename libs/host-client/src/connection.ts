import { browserCrypto, type IdentityCrypto } from './crypto'
import { createHandshake } from './handshake'
import { createRequests, type CommandResult } from './requests'
import { receiveFrame, type AttentionFrame, type ReceiveContext } from './connection/receive'
import {
  clearSubscriptions,
  createSubscriptionState,
  dropInputs,
  resubscribe,
  sendInput,
  subscribeLanes,
  watchLane,
  watchTerminal,
  type LaneFrame,
  type SubscriptionPorts,
  type TerminalListener,
} from './connection/subscriptions'
export type { CommandResult, NotSent } from './requests'
export type { LaneFrame } from './connection/subscriptions'
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
} from '@phosphor/shared/host-protocol'
import type { HostConnectionView } from '@phosphor/shared/ipc'
import type { TraceLog } from './ports'

export type HostConnectionSnapshot = Omit<HostConnectionView, 'lanes'> & { lanes: LaneSummary[] }

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
  onAttention?: (event: AttentionFrame['event']) => void
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
    hostId: ports.hostId,
    log,
  })
  let runtimeEpoch = ''
  const subscriptions = createSubscriptionState()
  const subscriptionPorts: SubscriptionPorts = {
    identity,
    write,
    later,
    cancel: (timer) => {
      clearTimeout(timer)
      timers.delete(timer)
    },
    unrefTimer: ports.unrefTimer,
    transportFailed: () => socket?.close(1000, 'Transport failed'),
    ready: () => view.state === 'ready',
    stopped: () => stopped,
  }
  const attention: AttentionFrame[] = []
  const frames: ReceiveContext = {
    subscriptions,
    requests,
    attention,
    ports,
    view: () => view,
    update,
    advanceCursor: (cursor) => {
      view = { ...view, cursor }
    },
    subscribe: (id, laneId, after) => subscribeLanes(subscriptionPorts, id, laneId, after),
    close: (code, reason) => socket?.close(code, reason),
    renewed(grantExpiresAt) {
      if (!renewalTimeout) {
        socket?.close(4400, 'Unexpected renewal')
        return
      }
      clearTimeout(renewalTimeout)
      timers.delete(renewalTimeout)
      renewalTimeout = undefined
      renew(grantExpiresAt)
    },
    pong: () => {
      lastPong = now()
    },
  }
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
    clearSubscriptions(subscriptions)
  }
  function failed(code: number, error?: string) {
    if (stopped) return
    if (
      error &&
      !['grant-refused', 'account-disabled', 'too-many-requests', 'signed-out'].includes(error)
    )
      error = 'offline'
    generation++
    dropInputs(subscriptions)
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
        capabilities: [...f.capabilities],
      })
      if (stopped) return
      log('hosts', 'ready', {
        hostId: ports.hostId,
        connectionId: f.connectionId,
        version: f.hello.hostVersion,
        caps: f.capabilities,
      })
      resubscribe(subscriptions, subscriptionPorts, view.cursor)
      requests.flushReplay()
      renew(f.grantExpiresAt)
      beat()
      return
    }
    receiveFrame(frames, f)
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
    watchTerminal(terminalId: string, listener: TerminalListener) {
      return watchTerminal(subscriptions, subscriptionPorts, terminalId, listener)
    },
    input(terminalId: string, seq: number, data: string): Promise<boolean> {
      return sendInput(subscriptions, subscriptionPorts, terminalId, seq, data)
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
      return watchLane(subscriptions, subscriptionPorts, laneId, listener)
    },
  }
}
