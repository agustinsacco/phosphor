import { isUuid } from '../control-api'
import { GRANT_LIMITS } from '../host-grant'
import {
  HOST_LIMITS,
  HOST_CALL_METHODS,
  parseClientFrame,
  utf8Length,
  type FrameSocket,
  type HostFrame,
  type ClientFrame,
  type LaneEvent,
  type AttentionEvent,
} from '../host-protocol'
import type { ExtensionUIRequest } from '../rpc'
import { authenticate, authorized } from './fake-host/auth'
import { command } from './fake-host/commands'
import { send as sendFrame } from './fake-host/delivery'
import { prune, rejected } from './fake-host/receipts'
import {
  createFakeHostState,
  type Connection,
  type FakeHostOptions,
  type Lane,
} from './fake-host/state'
import * as streams from './fake-host/streams'

export type { FakeHostOptions } from './fake-host/state'

/** In-memory executable protocol model. It never starts pi, reads disk or opens a listener. */
export function createFakeHost(options: FakeHostOptions) {
  const state = createFakeHostState(options)
  const { limits, repositories, connections, lanes, receipts } = state
  const { revokedSessions, revokedClients, attention, timers } = state
  const send = (c: Connection, frame: HostFrame) => sendFrame(state, c, frame)
  const snap = (lane: Lane) => streams.snapshot(state, lane)
  const publish = (lane: Lane, event: LaneEvent) => streams.publish(state, sendFrame, lane, event)
  const summary = (lane: Lane) => streams.summary(state, sendFrame, lane)
  const notify = (lane: Lane, kind: AttentionEvent['kind']) =>
    streams.notify(state, sendFrame, lane, kind)
  const turn = (lane: Lane) => streams.turn(state, sendFrame, lane)
  function handle(c: Connection, f: ClientFrame) {
    if (f.type === 'auth') {
      authenticate(state, c, f)
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
        command(state, c, f, authorized(state, c, 'sessions.control'))
        break
      case 'receipt-status': {
        prune(state)
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
        if (!authorized(state, c, 'sessions.read')) {
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
        if (!authorized(state, c, 'sessions.read')) {
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
          if (c.socket.isOpen() && authorized(state, c, 'sessions.read'))
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
          if (p.reply?.kind === 'receipt') rejected(state, c, p.reply.requestId, p.reply.code)
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
