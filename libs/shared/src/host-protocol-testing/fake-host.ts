import { CONTROL_LIMITS, isUuid } from '../control-api'
import {
  checkGrantClaims,
  splitGrant,
  grantUtf8,
  encodeBase64url,
  GRANT_LIMITS,
  type GrantExpectations,
  type GrantPayload,
} from '../host-grant'
import {
  HOST_LIMITS,
  HOST_PROTOCOL_VERSION,
  HOST_CALL_METHODS,
  parseClientFrame,
  helloProofMessage,
  utf8Length,
  type FrameSocket,
  type HostFrame,
  type ClientFrame,
  type LaneSummary,
  type LaneSnapshot,
  type LaneEvent,
  type StreamCursor,
  type Receipt,
  type RepositorySummary,
  type RejectCode,
  type AttentionEvent,
} from '../host-protocol'
import type { HostCapability } from '../remote-host'
import type { ExtensionUIRequest, PiEvent, AgentMessage, ThinkingLevel } from '../rpc'

type Limits = { -readonly [K in keyof typeof HOST_LIMITS]: number }
type Command = Extract<ClientFrame, { type: 'command' }>
interface Lane {
  summary: LaneSummary
  thinkingLevel: ThinkingLevel
  seq: number
  events: { cursor: StreamCursor; event: LaneEvent; bytes: number }[]
  replayBytes: number
  messages: AgentMessage[]
  pending: PiEvent[]
  dialogs: ExtensionUIRequest[]
  ui: Map<string, ExtensionUIRequest>
}
interface Connection {
  socket: FrameSocket
  grant: GrantPayload | null
  subscriptions: Map<string, Extract<ClientFrame, { type: 'subscribe' }>>
  wanted: Set<string>
  delivered: Set<string>
  pending: number
  stale: Set<string>
  recoveryTimer?: ReturnType<typeof setTimeout>
  authTimer: ReturnType<typeof setTimeout>
  expiryTimer?: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
}
interface Stored {
  clientId: string
  hash: string
  receipt: Receipt
  at: number
}
export interface FakeHostOptions {
  expectations: Omit<GrantExpectations, 'revokedSessions' | 'revokedClients'>
  verify: (bytes: Uint8Array, signature: Uint8Array, kid: string) => boolean
  sign: (bytes: Uint8Array) => Uint8Array
  verifyGrant?: (token: string) => GrantPayload | null
  id: () => string
  epoch: () => string
  capabilities?: readonly HostCapability[]
  repositories?: readonly RepositorySummary[]
  limits?: Partial<Limits>
  commandDelayMs?: number
}

/** In-memory executable protocol model. It never starts pi, reads disk or opens a listener. */
export function createFakeHost(options: FakeHostOptions) {
  const limits: Limits = { ...HOST_LIMITS }
  for (const key in HOST_LIMITS) {
    if (!limitKey(key)) continue
    const value = options.limits?.[key]
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[key])
        throw new Error('Invalid limit')
      limits[key] = value
    }
  }
  const caps = options.capabilities ?? ['sessions.read', 'sessions.control']
  const repositories = options.repositories ?? [
    { id: '0123456789abcdef', name: 'Test repository', path: '/test/repository' },
  ]
  if (repositories.length > limits.repositoriesPerHost) throw new Error('Too many repositories')
  const connections = new Set<Connection>(),
    lanes = new Map<string, Lane>(),
    receipts = new Map<string, Stored>()
  const revokedSessions = new Set<string>(),
    revokedClients = new Set<string>()
  const attention: { cursor: StreamCursor; event: AttentionEvent }[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let epoch = options.epoch(),
    hostSeq = 0,
    stopped = false,
    executions = 0
  const now = () => new Date().toISOString()
  function forget(id: string) {
    receipts.delete(id)
    for (const c of connections) {
      c.wanted.delete(id)
      c.delivered.delete(id)
    }
  }
  function prune() {
    for (const [id, r] of receipts)
      if (Date.now() - r.at >= limits.receiptTtlMs && r.receipt.status !== 'pending') forget(id)
    const finished = [...receipts].filter(([, r]) => r.receipt.status !== 'pending')
    for (const [id] of finished.slice(0, Math.max(0, finished.length - limits.receiptsKept)))
      forget(id)
  }
  function catchUp(c: Connection, id: string): HostFrame | null {
    const sub = c.subscriptions.get(id)
    if (!sub) return null
    if (sub.topic === 'lanes')
      return {
        type: 'lanes',
        id,
        cursor: { epoch, seq: hostSeq },
        repositories,
        lanes: [...lanes.values()].map((l) => l.summary),
      }
    const l = lanes.get(sub.laneId)
    return l ? { type: 'snapshot', id, laneId: sub.laneId, reset: true, snapshot: snap(l) } : null
  }
  function recover(c: Connection) {
    if (c.recoveryTimer !== undefined) return
    c.recoveryTimer = setTimeout(() => {
      c.recoveryTimer = undefined
      if (!c.socket.isOpen()) return
      if (c.socket.bufferedBytes() < limits.sendQueueBytes / 2) {
        for (const id of [...c.stale]) {
          c.stale.delete(id)
          const frame = catchUp(c, id)
          if (frame) send(c, frame)
        }
      }
      if (c.stale.size) recover(c)
    }, 50)
    c.recoveryTimer.unref?.()
  }
  function send(c: Connection, frame: HostFrame): 'sent' | 'reset' | 'failed' | 'dropped' {
    if (!c.socket.isOpen()) return 'dropped'
    let outcome: 'sent' | 'failed' = 'sent'
    const subId =
      'id' in frame && c.subscriptions.has(frame.id) && frame.type !== 'result' ? frame.id : null
    if (subId && c.stale.has(subId)) return 'dropped'
    let s = JSON.stringify(frame)
    if (
      utf8Length(s) > limits.outboundFrameBytes ||
      (subId && utf8Length(s) > limits.sendQueueBytes)
    ) {
      if (frame.type === 'event') {
        const replacement = catchUp(c, frame.id)
        if (!replacement) return 'dropped'
        const result = send(c, replacement)
        return result === 'sent' ? 'reset' : result
      }
      if (subId) {
        c.subscriptions.delete(subId)
        c.stale.delete(subId)
        frame = { type: 'subscribe-failed', id: subId, code: 'too-large' }
        outcome = 'failed'
      } else if (frame.type === 'result')
        frame = {
          type: 'result',
          id: frame.id,
          ok: false,
          error: { code: 'too-large', message: 'Result too large' },
        }
      else {
        c.socket.close(4429, 'Outbound limit')
        return 'failed'
      }
      s = JSON.stringify(frame)
    }
    if (c.socket.bufferedBytes() + utf8Length(s) > limits.sendQueueBytes) {
      if (subId && c.subscriptions.has(subId)) {
        c.stale.add(subId)
        recover(c)
      } else c.socket.close(4429, 'Slow client')
      return 'dropped'
    }
    c.socket.send(s)
    return outcome
  }
  function authorized(c: Connection, cap: HostCapability) {
    return c.grant?.caps.includes(cap) && caps.includes(cap)
  }
  function snap(lane: Lane): LaneSnapshot {
    return {
      cursor: { epoch, seq: lane.seq },
      summary: lane.summary,
      state:
        lane.summary.activity === 'stopped' || lane.summary.activity === 'failed'
          ? null
          : {
              sessionId: lane.summary.laneId,
              thinkingLevel: lane.thinkingLevel,
              isStreaming: lane.summary.activity === 'working',
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'all',
              autoCompactionEnabled: true,
              messageCount: lane.messages.length,
              pendingMessageCount: lane.pending.length,
              ...(lane.summary.title !== null ? { sessionName: lane.summary.title } : {}),
            },
      messages: lane.messages,
      pending: lane.pending,
      dialogs: lane.dialogs,
      ui: [...lane.ui.values()],
    }
  }
  function publish(lane: Lane, event: LaneEvent) {
    const entry = {
      cursor: { epoch, seq: ++lane.seq },
      event,
      bytes: utf8Length(JSON.stringify(event)),
    }
    lane.events.push(entry)
    lane.replayBytes += entry.bytes
    while (lane.events.length > limits.replayEvents || lane.replayBytes > limits.replayBytes) {
      const old = lane.events.shift()
      if (old) lane.replayBytes -= old.bytes
    }
    for (const c of connections)
      for (const s of c.subscriptions.values()) {
        if (s.topic === 'lane' && s.laneId === lane.summary.laneId) {
          const frame: HostFrame = {
            type: 'event',
            id: s.id,
            laneId: s.laneId,
            cursor: entry.cursor,
            event,
          }
          if (utf8Length(JSON.stringify(frame)) > limits.outboundFrameBytes)
            send(c, {
              type: 'snapshot',
              id: s.id,
              laneId: s.laneId,
              reset: true,
              snapshot: snap(lane),
            })
          else send(c, frame)
        }
      }
  }
  function summary(lane: Lane) {
    lane.summary = { ...lane.summary, updatedAt: now() }
    publish(lane, { kind: 'summary', summary: lane.summary })
    announce(lane)
  }
  function announce(lane: Lane) {
    const cursor = { epoch, seq: ++hostSeq }
    for (const c of connections)
      for (const s of c.subscriptions.values())
        if (s.topic === 'lanes')
          send(c, { type: 'lanes-delta', id: s.id, cursor, upsert: [lane.summary], remove: [] })
  }
  function notify(lane: Lane, kind: AttentionEvent['kind']) {
    lane.summary = { ...lane.summary, attention: lane.summary.attention + 1 }
    summary(lane)
    const entry = {
      cursor: { epoch, seq: ++hostSeq },
      event: {
        id: `${lane.summary.laneId}:${lane.summary.attention}`,
        laneId: lane.summary.laneId,
        kind,
        attention: lane.summary.attention,
        at: now(),
        title: lane.summary.title,
      },
    }
    attention.push(entry)
    while (attention.length > limits.attentionReplay) attention.shift()
    for (const c of connections)
      for (const s of c.subscriptions.values())
        if (s.topic === 'lanes') send(c, { type: 'attention', id: s.id, ...entry })
  }
  function changeControl(lane: Lane, controller: LaneSummary['control']['controller']) {
    lane.summary = {
      ...lane.summary,
      control: { fence: lane.summary.control.fence + 1, controller },
    }
    publish(lane, { kind: 'control', control: lane.summary.control })
    summary(lane)
  }
  function push(lane: Lane, event: PiEvent) {
    if (lane.pending.length >= limits.pendingEvents)
      throw new Error('Scripted pending limit exceeded')
    lane.pending.push(event)
    publish(lane, { kind: 'pi', push: { kind: 'event', event } })
  }
  function turn(lane: Lane) {
    lane.summary = { ...lane.summary, activity: 'working' }
    summary(lane)
    push(lane, { type: 'agent_start' })
    const message: AgentMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Scripted reply' }],
      timestamp: Date.now(),
    }
    // The fake's deltas are intentionally shallow; pi owns the inner event shape.
    for (const delta of ['Scripted ', 'reply'])
      push(lane, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
      })
    push(lane, { type: 'message_end', message })
    lane.messages.push(message)
    // A fake transcript stops growing at the wire cap; it never silently truncates history.
    if (utf8Length(JSON.stringify(lane.messages)) > HOST_LIMITS.outboundFrameBytes)
      throw new Error('Scripted transcript limit exceeded')
    lane.pending.length = 0
    push(lane, { type: 'agent_end', messages: [message] })
    lane.pending.length = 0
    lane.summary = { ...lane.summary, activity: 'idle' }
    notify(lane, 'finished')
  }
  function deliver(requestId: string, stored: Stored) {
    if (stored.receipt.status !== 'pending') prune()
    for (const c of connections)
      if (
        c.grant?.client.id === stored.clientId &&
        c.wanted.has(requestId) &&
        !c.delivered.has(requestId)
      ) {
        send(c, { type: 'receipt', receipt: stored.receipt })
        if (stored.receipt.status !== 'pending') {
          c.delivered.add(requestId)
          c.wanted.delete(requestId)
        }
      }
  }
  function rejected(c: Connection, requestId: string, code: RejectCode, lane?: Lane) {
    send(c, {
      type: 'receipt',
      receipt: {
        requestId,
        status: 'rejected',
        code,
        ...(lane ? { control: lane.summary.control } : {}),
      },
    })
  }
  function command(c: Connection, f: Command) {
    const grant = c.grant
    if (!grant) return
    prune()
    const hash = JSON.stringify({ laneId: f.laneId, fence: f.fence, op: f.op })
    const old = receipts.get(f.requestId)
    if (old) {
      if (old.clientId !== grant.client.id || old.hash !== hash) {
        rejected(c, f.requestId, 'conflict')
        return
      }
      if (!c.delivered.has(f.requestId)) c.wanted.add(f.requestId)
      deliver(f.requestId, old)
      return
    }
    if (c.pending >= limits.pendingCommandsPerConnection) {
      rejected(c, f.requestId, 'too-many-requests')
      return
    }
    if (
      [...receipts.values()].filter((r) => r.receipt.status === 'pending').length >=
      limits.receiptsKept
    ) {
      rejected(c, f.requestId, 'busy')
      return
    }
    const stored: Stored = {
      clientId: grant.client.id,
      hash,
      receipt: { requestId: f.requestId, status: 'pending' },
      at: Date.now(),
    }
    receipts.set(f.requestId, stored)
    c.wanted.add(f.requestId)
    const reject = (code: RejectCode, lane?: Lane) => {
      stored.receipt = {
        requestId: f.requestId,
        status: 'rejected',
        code,
        ...(lane ? { control: lane.summary.control } : {}),
      }
      deliver(f.requestId, stored)
    }
    if (!authorized(c, 'sessions.control')) {
      reject('forbidden')
      return
    }
    let lane = f.laneId ? lanes.get(f.laneId) : undefined
    if (f.op.type === 'lane.create') {
      const operation = f.op
      if (f.laneId !== undefined || !repositories.some((r) => r.id === operation.repositoryId)) {
        reject('bad-request')
        return
      }
      if (lanes.size >= limits.lanesPerHost) {
        reject('too-many-requests')
        return
      }
      const laneId = options.id()
      lane = {
        summary: {
          laneId,
          repositoryId: f.op.repositoryId,
          cwd: repositories.find((r) => r.id === operation.repositoryId)?.path ?? '/test',
          title: f.op.name ?? null,
          branch: f.op.worktree?.branch ?? null,
          worktree: f.op.worktree !== null,
          model: f.op.provider && f.op.model ? { provider: f.op.provider, id: f.op.model } : null,
          activity: 'idle',
          createdAt: now(),
          updatedAt: now(),
          attention: 0,
          read: 0,
          control: {
            fence: 1,
            controller: { clientId: grant.client.id, label: grant.client.label, connected: true },
          },
        },
        thinkingLevel: f.op.thinkingLevel === undefined ? 'off' : thinkingLevel(f.op.thinkingLevel),
        seq: 0,
        events: [],
        replayBytes: 0,
        messages: [],
        pending: [],
        dialogs: [],
        ui: new Map(),
      }
      lanes.set(laneId, lane)
      announce(lane)
      stored.receipt = { requestId: f.requestId, status: 'done', laneId, fence: 1 }
      deliver(f.requestId, stored)
      return
    }
    if (!lane) {
      reject('unknown-lane')
      return
    }
    const l = lane
    if (f.op.type !== 'control.take' && f.op.type !== 'lane.markRead') {
      if (f.fence !== l.summary.control.fence) {
        reject('stale-fence', l)
        return
      }
      const controller = l.summary.control.controller
      if (controller && controller.clientId !== grant.client.id) {
        reject('not-controller', l)
        return
      }
      if (f.op.type === 'control.release' && !controller) {
        reject('not-controller', l)
        return
      }
      if (!controller)
        changeControl(l, { clientId: grant.client.id, label: grant.client.label, connected: true })
    }
    if (f.op.type === 'control.take')
      changeControl(l, { clientId: grant.client.id, label: grant.client.label, connected: true })
    else if (f.op.type === 'control.release') changeControl(l, null)
    else if (f.op.type === 'lane.markRead') {
      l.summary = {
        ...l.summary,
        read: Math.max(l.summary.read, Math.min(f.op.upTo, l.summary.attention)),
      }
      summary(l)
    } else if (f.op.type === 'lane.stop') {
      l.summary = { ...l.summary, activity: 'stopped' }
      summary(l)
    } else if (f.op.type === 'lane.resume') {
      l.summary = { ...l.summary, activity: 'idle' }
      summary(l)
    } else if (l.summary.activity === 'stopped' || l.summary.activity === 'failed') {
      reject('lane-stopped')
      return
    } else if (f.op.type === 'extension_ui_response') {
      const id = f.op.response.id
      if (!l.dialogs.some((d) => d.id === id)) {
        reject('bad-request')
        return
      }
      l.dialogs = l.dialogs.filter((d) => d.id !== id)
      publish(l, { kind: 'dialog-resolved', dialogId: id })
      l.summary = { ...l.summary, activity: l.dialogs.length ? 'needs-input' : 'idle' }
      summary(l)
    } else if (f.op.type === 'set_session_name') {
      l.summary = { ...l.summary, title: f.op.name }
      summary(l)
    } else if (f.op.type === 'set_thinking_level') {
      l.thinkingLevel = f.op.level
    } else if (f.op.type === 'set_model') {
      l.summary = { ...l.summary, model: { provider: f.op.provider, id: f.op.modelId } }
      summary(l)
    }
    c.pending++
    executions++
    const startingEpoch = epoch
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (epoch !== startingEpoch || stored.receipt.status !== 'pending') return
      clearTimeout(deadline)
      timers.delete(deadline)
      c.pending--
      if (l.summary.activity === 'failed') {
        stored.receipt = { requestId: f.requestId, status: 'unknown' }
        deliver(f.requestId, stored)
        return
      }
      if (f.op.type === 'prompt') turn(l)
      stored.receipt = { requestId: f.requestId, status: 'done', fence: l.summary.control.fence }
      deliver(f.requestId, stored)
    }, options.commandDelayMs ?? 1)
    const deadline = setTimeout(() => {
      timers.delete(deadline)
      if (epoch !== startingEpoch || stored.receipt.status !== 'pending') return
      clearTimeout(timer)
      timers.delete(timer)
      c.pending--
      stored.receipt = { requestId: f.requestId, status: 'unknown' }
      deliver(f.requestId, stored)
    }, limits.commandAnswerMs)
    timers.add(timer)
    timers.add(deadline)
  }
  function handle(c: Connection, f: ClientFrame) {
    if (f.type === 'auth') {
      let grant: GrantPayload | null = null
      if (options.verifyGrant) grant = options.verifyGrant(f.grant)
      else {
        const p = splitGrant(f.grant)
        if (p.ok && options.verify(p.value.payloadBytes, p.value.signature, p.value.payload.kid))
          grant = p.value.payload
      }
      if (!grant) {
        c.socket.close(4401, 'Invalid grant')
        return
      }
      const failure = checkGrantClaims(
        grant,
        { ...options.expectations, revokedSessions, revokedClients },
        Date.now() / 1000,
        CONTROL_LIMITS.signatureSkewSec,
      )
      if (failure) {
        c.socket.close(
          failure === 'expired' || failure === 'not-yet-valid' || failure === 'lifetime'
            ? 4401
            : 4403,
          'Grant refused',
        )
        return
      }
      if (c.grant) {
        if (
          c.grant.sub !== grant.sub ||
          c.grant.client.id !== grant.client.id ||
          f.challenge !== undefined
        ) {
          c.socket.close(4403, 'Identity changed')
          return
        }
      } else {
        if (!f.challenge) {
          c.socket.close(4401, 'Challenge required')
          return
        }
        if (
          [...connections].filter((x) => x.grant?.client.id === grant.client.id).length >=
          limits.connectionsPerClient
        ) {
          c.socket.close(4429, 'Too many connections')
          return
        }
      }
      const renewal = c.grant !== null
      c.grant = grant
      clearTimeout(c.authTimer)
      clearTimeout(c.expiryTimer)
      c.expiryTimer = setTimeout(
        () => c.socket.close(4401, 'Grant expired'),
        Math.max(0, (grant.exp + CONTROL_LIMITS.signatureSkewSec) * 1000 - Date.now()),
      )
      if (renewal) {
        if (!authorized(c, 'sessions.read')) {
          c.subscriptions.clear()
          c.stale.clear()
        }
        send(c, { type: 'auth-renewed', grantExpiresAt: new Date(grant.exp * 1000).toISOString() })
      } else {
        const challenge = f.challenge ?? ''
        send(c, {
          type: 'ready',
          protocolVersion: HOST_PROTOCOL_VERSION,
          hello: {
            hostId: options.expectations.hostId,
            hostVersion: '0.0.0',
            protocolVersion: 1,
            runtimeEpoch: epoch,
            capabilities: [...caps],
          },
          proof: encodeBase64url(
            options.sign(
              grantUtf8(helloProofMessage(options.expectations.hostId, epoch, challenge)),
            ),
          ),
          connectionId: options.epoch(),
          grantExpiresAt: new Date(grant.exp * 1000).toISOString(),
          client: grant.client,
          capabilities: grant.caps.filter((cap) => caps.includes(cap)),
        })
        for (const l of lanes.values()) {
          const controller = l.summary.control.controller
          if (controller?.clientId === grant.client.id && !controller.connected) {
            l.summary = {
              ...l.summary,
              control: { ...l.summary.control, controller: { ...controller, connected: true } },
            }
            publish(l, { kind: 'control', control: l.summary.control })
            summary(l)
          }
        }
      }
      return
    }
    if (!c.grant) {
      c.socket.close(4401, 'Auth required')
      return
    }
    switch (f.type) {
      case 'ping':
        send(c, { type: 'pong', at: f.at })
        break
      case 'unsubscribe':
        c.subscriptions.delete(f.id)
        c.stale.delete(f.id)
        break
      case 'command':
        command(c, f)
        break
      case 'receipt-status': {
        prune()
        const r = receipts.get(f.requestId)
        if (!r || r.clientId !== c.grant.client.id)
          send(c, { type: 'receipt', receipt: { requestId: f.requestId, status: 'unknown' } })
        else {
          if (!c.delivered.has(f.requestId)) c.wanted.add(f.requestId)
          deliver(f.requestId, r)
        }
        break
      }
      case 'subscribe': {
        if (!authorized(c, 'sessions.read')) {
          send(c, { type: 'subscribe-failed', id: f.id, code: 'forbidden' })
          break
        }
        if (c.subscriptions.has(f.id)) {
          send(c, { type: 'subscribe-failed', id: f.id, code: 'bad-request' })
          break
        }
        if (c.subscriptions.size >= limits.subscriptionsPerConnection) {
          send(c, { type: 'subscribe-failed', id: f.id, code: 'too-many' })
          break
        }
        if (f.topic === 'lanes') {
          c.subscriptions.set(f.id, f)
          const result = send(c, {
            type: 'lanes',
            id: f.id,
            cursor: { epoch, seq: hostSeq },
            repositories,
            lanes: [...lanes.values()].map((l) => l.summary),
          })
          if (result !== 'sent') break
          if (f.after?.epoch === epoch)
            for (const entry of attention)
              if (
                entry.cursor.seq > f.after.seq &&
                send(c, { type: 'attention', id: f.id, ...entry }) !== 'sent'
              )
                break
        } else {
          const l = lanes.get(f.laneId)
          if (!l) {
            send(c, { type: 'subscribe-failed', id: f.id, code: 'unknown-lane' })
            break
          }
          c.subscriptions.set(f.id, f)
          if (
            f.after?.epoch === epoch &&
            f.after.seq <= l.seq &&
            f.after.seq >= (l.events[0]?.cursor.seq ?? l.seq + 1) - 1
          ) {
            for (const entry of l.events)
              if (entry.cursor.seq > f.after.seq) {
                const result = send(c, {
                  type: 'event',
                  id: f.id,
                  laneId: f.laneId,
                  cursor: entry.cursor,
                  event: entry.event,
                })
                if (result !== 'sent') break
              }
          } else
            send(c, {
              type: 'snapshot',
              id: f.id,
              laneId: f.laneId,
              reset: f.after !== undefined,
              snapshot: snap(l),
            })
        }
        break
      }
      case 'call': {
        const error = (code: Extract<HostFrame, { type: 'result'; ok: false }>['error']['code']) =>
          send(c, { type: 'result', id: f.id, ok: false, error: { code, message: code } })
        if (!authorized(c, 'sessions.read')) {
          error('forbidden')
          break
        }
        if (!HOST_CALL_METHODS.some((m) => m === f.method)) {
          error('unsupported')
          break
        }
        if (f.method === 'host.repositories') {
          send(c, { type: 'result', id: f.id, ok: true, data: repositories })
          break
        }
        const laneId = paramsLane(f.params)
        const l = laneId ? lanes.get(laneId) : undefined
        if (!laneId) {
          error('bad-request')
          break
        }
        if (!l) {
          error('unknown-lane')
          break
        }
        const data =
          f.method === 'lane.messages'
            ? { messages: l.messages }
            : f.method === 'lane.state'
              ? snap(l).state
              : f.method === 'lane.models'
                ? { models: [] }
                : f.method === 'lane.commands'
                  ? { commands: [] }
                  : {
                      sessionId: laneId,
                      userMessages: 0,
                      assistantMessages: l.messages.length,
                      toolCalls: 0,
                      toolResults: 0,
                      totalMessages: l.messages.length,
                      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                      cost: 0,
                    }
        send(c, { type: 'result', id: f.id, ok: true, data })
        break
      }
    }
  }
  function lane(id: string): Lane {
    const l = lanes.get(id)
    if (!l) throw new Error('Unknown lane')
    return l
  }
  return {
    attach(socket: FrameSocket) {
      if (stopped) {
        socket.close(1001, 'Host stopping')
        return
      }
      // An unauthenticated flood cannot allocate an unbounded timer/connection set.
      if (connections.size >= limits.connectionsPerClient * limits.lanesPerHost) {
        socket.close(4429, 'Too many connections')
        return
      }
      const c: Connection = {
        socket,
        grant: null,
        subscriptions: new Map(),
        wanted: new Set(),
        delivered: new Set(),
        pending: 0,
        stale: new Set(),
        authTimer: setTimeout(() => socket.close(4401, 'Auth timeout'), limits.authTimeoutMs),
      }
      connections.add(c)
      socket.onMessage((s) => {
        clearTimeout(c.idleTimer)
        c.idleTimer = setTimeout(() => socket.close(4401, 'Idle'), limits.idleCloseMs)
        if (utf8Length(s) > limits.inboundFrameBytes) {
          socket.close(4400, 'Frame too large')
          return
        }
        const p = parseClientFrame(s)
        if (!p.ok) {
          if (!c.grant) {
            socket.close(4401, 'Auth required')
            return
          }
          if (p.reply?.kind === 'receipt') rejected(c, p.reply.requestId, p.reply.code)
          else if (p.reply?.kind === 'result')
            send(c, {
              type: 'result',
              id: p.reply.id,
              ok: false,
              error: { code: p.reply.code, message: p.reply.code },
            })
          else socket.close(4400, 'Bad frame')
        } else handle(c, p.frame)
      })
      socket.onClose(() => {
        connections.delete(c)
        clearTimeout(c.authTimer)
        clearTimeout(c.expiryTimer)
        clearTimeout(c.idleTimer)
        clearTimeout(c.recoveryTimer)
        for (const l of lanes.values())
          if (
            l.summary.control.controller &&
            l.summary.control.controller.clientId === c.grant?.client.id &&
            ![...connections].some((other) => other.grant?.client.id === c.grant?.client.id)
          ) {
            l.summary = {
              ...l.summary,
              control: {
                ...l.summary.control,
                controller: { ...l.summary.control.controller, connected: false },
              },
            }
            publish(l, { kind: 'control', control: l.summary.control })
            summary(l)
          }
      })
    },
    emitTurn(id: string) {
      turn(lane(id))
    },
    emitUi(id: string, request: ExtensionUIRequest) {
      const l = lane(id)
      if (
        request.method === 'setStatus' ||
        request.method === 'setWidget' ||
        request.method === 'setTitle'
      ) {
        const prefix =
          request.method === 'setStatus'
            ? 'status:'
            : request.method === 'setWidget'
              ? 'widget:'
              : 'title:'
        const key =
          prefix +
          (request.method === 'setStatus'
            ? request.statusKey
            : request.method === 'setWidget'
              ? request.widgetKey
              : '')
        const clear =
          request.method === 'setStatus'
            ? request.statusText === undefined
            : request.method === 'setWidget'
              ? !request.widgetLines?.length
              : false
        if (clear) l.ui.delete(key)
        else {
          const bound =
            request.method === 'setStatus'
              ? limits.uiStatusKeys
              : request.method === 'setWidget'
                ? limits.uiWidgetKeys
                : 1
          if (
            !l.ui.has(key) &&
            [...l.ui.keys()].filter((k) => k.startsWith(prefix)).length >= bound
          )
            throw new Error('UI keys full')
          if (utf8Length(JSON.stringify(request)) > HOST_LIMITS.outboundFrameBytes)
            throw new Error('UI request too large')
          l.ui.set(key, request)
        }
      }
      publish(l, { kind: 'pi', push: { kind: 'extension-ui', request } })
    },
    openDialog(id: string, dialogId = 'dialog') {
      const l = lane(id)
      if (l.dialogs.length >= limits.pendingEvents) throw new Error('Too many dialogs')
      const d: ExtensionUIRequest = {
        type: 'extension_ui_request',
        id: dialogId,
        method: 'confirm',
        title: 'Continue?',
        message: 'Scripted question',
      }
      l.dialogs.push(d)
      l.summary = { ...l.summary, activity: 'needs-input' }
      publish(l, { kind: 'pi', push: { kind: 'extension-ui', request: d } })
      notify(l, 'needs-input')
    },
    failLane(id: string) {
      const l = lane(id)
      l.summary = { ...l.summary, activity: 'failed' }
      publish(l, { kind: 'pi', push: { kind: 'exit', code: 1, signal: null, expected: false } })
      notify(l, 'failed')
    },
    restart() {
      epoch = options.epoch()
      hostSeq = 0
      attention.length = 0
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const r of receipts.values())
        if (r.receipt.status === 'pending')
          r.receipt = { requestId: r.receipt.requestId, status: 'unknown' }
      for (const l of lanes.values()) {
        l.seq = 0
        l.events.length = 0
        l.replayBytes = 0
        l.pending.length = 0
      }
      for (const c of connections) c.socket.close(1001, 'Host restarting')
    },
    revokeSession(id: string) {
      if (revokedSessions.size >= GRANT_LIMITS.revocations) throw new Error('Revocations full')
      revokedSessions.add(id)
      for (const c of connections) if (c.grant?.sid === id) c.socket.close(4403, 'Revoked')
    },
    revokeClient(id: string) {
      if (revokedClients.size >= GRANT_LIMITS.revocations) throw new Error('Revocations full')
      revokedClients.add(id)
      for (const c of connections) if (c.grant?.client.id === id) c.socket.close(4403, 'Revoked')
    },
    executions: () => executions,
    stop() {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const c of connections) c.socket.close(1001, 'Host stopping')
    },
  }
}
function paramsLane(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || !('laneId' in v)) return null
  return isUuid(v.laneId) ? v.laneId : null
}
function limitKey(key: string): key is keyof Limits {
  return key in HOST_LIMITS
}

function thinkingLevel(value: string): ThinkingLevel {
  switch (value) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value
    default:
      throw new Error('Invalid thinking level')
  }
}
