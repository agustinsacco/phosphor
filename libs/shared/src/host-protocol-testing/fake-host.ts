import { CONTROL_LIMITS, isUuid } from '../control-api'
import {
  checkGrantClaims,
  splitGrant,
  grantUtf8,
  encodeBase64url,
  GRANT_LIMITS,
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
  type LaneEvent,
  type LaneSummary,
  type RejectCode,
  type AttentionEvent,
} from '../host-protocol'
import type { HostCapability } from '../remote-host'
import type { ExtensionUIRequest, ThinkingLevel } from '../rpc'
import { send as sendFrame } from './fake-host/delivery'
import {
  createFakeHostState,
  now,
  type Command,
  type Connection,
  type FakeHostOptions,
  type Lane,
  type Stored,
} from './fake-host/state'
import * as streams from './fake-host/streams'

export type { FakeHostOptions } from './fake-host/state'

/** In-memory executable protocol model. It never starts pi, reads disk or opens a listener. */
export function createFakeHost(options: FakeHostOptions) {
  const state = createFakeHostState(options)
  const { limits, caps, repositories, connections, lanes, receipts } = state
  const { revokedSessions, revokedClients, attention, timers } = state
  const send = (c: Connection, frame: HostFrame) => sendFrame(state, c, frame)
  const snap = (lane: Lane) => streams.snapshot(state, lane)
  const publish = (lane: Lane, event: LaneEvent) => streams.publish(state, sendFrame, lane, event)
  const summary = (lane: Lane) => streams.summary(state, sendFrame, lane)
  const announce = (lane: Lane) => streams.announce(state, sendFrame, lane)
  const notify = (lane: Lane, kind: AttentionEvent['kind']) =>
    streams.notify(state, sendFrame, lane, kind)
  const changeControl = (lane: Lane, controller: LaneSummary['control']['controller']) =>
    streams.changeControl(state, sendFrame, lane, controller)
  const turn = (lane: Lane) => streams.turn(state, sendFrame, lane)
  function forget(id: string) {
    receipts.delete(id)
    for (const c of connections) {
      c.wanted.delete(id)
      c.delivered.delete(id)
    }
  }
  function prune() {
    for (const [id, r] of receipts)
      if (r.finishedAt !== undefined && Date.now() - r.finishedAt > limits.receiptTtlMs) forget(id)
    const finished = [...receipts].filter(([, r]) => r.receipt.status !== 'pending')
    for (const [id] of finished.slice(0, Math.max(0, finished.length - limits.receiptsKept)))
      forget(id)
  }
  function authorized(c: Connection, cap: HostCapability) {
    return c.grant?.caps.includes(cap) && caps.includes(cap)
  }
  function deliver(requestId: string, stored: Stored) {
    if (stored.receipt.status !== 'pending') {
      stored.finishedAt ??= Date.now()
      prune()
    }
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
      send(c, { type: 'receipt', receipt: old.receipt })
      if (old.receipt.status === 'pending') c.wanted.add(f.requestId)
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
        sessionId: options.id(),
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
    state.executions++
    const startingEpoch = state.epoch
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (state.epoch !== startingEpoch || stored.receipt.status !== 'pending') return
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
      if (state.epoch !== startingEpoch || stored.receipt.status !== 'pending') return
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
            runtimeEpoch: state.epoch,
            capabilities: [...caps],
          },
          proof: encodeBase64url(
            options.sign(
              grantUtf8(helloProofMessage(options.expectations.hostId, state.epoch, challenge)),
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
          send(c, { type: 'receipt', receipt: r.receipt })
          if (r.receipt.status === 'pending') c.wanted.add(f.requestId)
        }
        break
      }
      case 'subscribe': {
        if (f.topic === 'terminal') {
          send(c, { type: 'subscribe-failed', id: f.id, code: 'bad-request' })
          break
        }
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
            cursor: { epoch: state.epoch, seq: state.hostSeq },
            repositories,
            lanes: [...lanes.values()].map((l) => l.summary),
          })
          if (result !== 'sent') break
          if (f.after?.epoch === state.epoch)
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
            f.after?.epoch === state.epoch &&
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
        if (c.calls >= limits.pendingCommandsPerConnection) {
          c.socket.close(4429, 'Too many calls')
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
        c.calls++
        const timer = setTimeout(() => {
          timers.delete(timer)
          c.calls--
          if (c.socket.isOpen() && authorized(c, 'sessions.read'))
            send(c, { type: 'result', id: f.id, ok: true, data })
        }, 0)
        timers.add(timer)
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
      if (state.stopped) {
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
        calls: 0,
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
      return turn(lane(id))
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
      state.epoch = options.epoch()
      state.hostSeq = 0
      attention.length = 0
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const r of receipts.values())
        if (r.receipt.status === 'pending') {
          r.receipt = { requestId: r.receipt.requestId, status: 'unknown' }
          r.finishedAt = Date.now()
        }
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
    executions: () => state.executions,
    stop() {
      state.stopped = true
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
