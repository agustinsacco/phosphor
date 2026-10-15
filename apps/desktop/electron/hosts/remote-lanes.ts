import { randomBytes, randomUUID } from 'node:crypto'
import {
  HOST_LIMITS,
  utf8Length,
  parseClientFrame,
  type LaneOp,
  type LaneSummary,
} from '@shared/host-protocol'
import type { LiveSessionInfo, SessionPush } from '@shared/models'
import type { ExtensionUIResponse, RpcCommand, RpcResponse } from '@shared/rpc'
import type { RemoteLaneCreate } from '@shared/ipc'
import { createLaneProjection } from '@phosphor/session-runtime/lanes/projection'
import type { createHostConnection, LaneFrame } from './connection'
import { laneOperation, receiptResponse, REMOTE_UNAVAILABLE } from './lane-ops'
import type { HostCapability } from '@shared/remote-host'
import type { WriteLane } from './write-features'

type Connection = ReturnType<typeof createHostConnection>
export interface RemoteWindow {
  id: number
  send: (channel: string, push: SessionPush) => void
  destroyed: () => boolean
}
type Handle = {
  info: LiveSessionInfo
  window: RemoteWindow
  hostId: string
  laneId: string
  summary: LaneSummary
  projection: ReturnType<typeof createLaneProjection>
  connection: Connection
  unwatch: () => void
  ready: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  hydration?: {
    view: ReturnType<ReturnType<typeof createLaneProjection>['view']>
    summary: LaneSummary
    held: SessionPush[]
    bytes: number
    timer: ReturnType<typeof setTimeout>
  }
  messageBytes: number
  lastState?: Record<string, unknown>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only a definitive fresh-branch rejection authorizes a new create request. */
class FreshBranchExists extends Error {}

export function isRemoteHandle(id: string): boolean {
  return /^remote-[0-9a-f]{16}$/.test(id)
}

export function createRemoteLanes(ports: {
  connection: (hostId: string) => Connection | undefined
  present: (hostId: string) => boolean
  label: (hostId: string) => string
  changed: () => void
}) {
  const handles = new Map<string, Handle>()
  const focused = new Map<number, { hostId: string; laneId: string }>()
  function connection(hostId: string, control = false) {
    const c = ports.connection(hostId)
    const view = c?.snapshot()
    if (
      !c ||
      view?.state !== 'ready' ||
      !view.capabilities.includes('sessions.read') ||
      (control && !view.capabilities.includes('sessions.control'))
    )
      throw new Error(REMOTE_UNAVAILABLE)
    return c
  }
  function push(h: Handle, value: SessionPush) {
    if (!h.window.destroyed()) h.window.send(`pi:event:${h.info.sessionId}`, value)
  }
  function reattach(h: Handle) {
    h.unwatch()
    h.unwatch = h.connection.watchLane(h.laneId, (frame) => receive(h, frame))
  }
  function projection(h: Handle) {
    return createLaneProjection({
      now: Date.now,
      overflow: () => {
        // Reattach without a cursor instead of retaining an incomplete projection.
        reattach(h)
      },
    })
  }
  function flush(h: Handle) {
    const hydration = h.hydration
    if (!hydration) return
    clearTimeout(hydration.timer)
    h.hydration = undefined
    for (const event of hydration.view.pending) push(h, { kind: 'event', event })
    for (const request of [...hydration.view.ui, ...hydration.view.dialogs])
      push(h, { kind: 'extension-ui', request })
    for (const value of hydration.held) push(h, value)
  }
  function resync(h: Handle) {
    if (h.hydration) clearTimeout(h.hydration.timer)
    h.hydration = {
      view: structuredClone(h.projection.view()),
      summary: structuredClone(h.summary),
      held: [],
      bytes: 0,
      timer: setTimeout(() => flush(h), 10_000),
    }
    push(h, { kind: 'resync' })
  }
  function deliver(h: Handle, value: SessionPush) {
    const hydration = h.hydration
    if (!hydration) {
      push(h, value)
      return
    }
    const bytes = utf8Length(JSON.stringify(value))
    if (
      hydration.held.length >= HOST_LIMITS.pendingEvents ||
      hydration.bytes + bytes > HOST_LIMITS.replayBytes
    ) {
      resync(h)
      return
    }
    hydration.held.push(value)
    hydration.bytes += bytes
  }
  function receive(h: Handle, frame: LaneFrame) {
    try {
      applyFrame(h, frame)
    } catch {
      h.reject(new Error('Lane stream unavailable.'))
      push(h, { kind: 'exit', code: null, signal: null, expected: false })
      if (handles.has(h.info.sessionId)) dispose(h.window.id, h.info.sessionId)
    }
  }
  function applyFrame(h: Handle, frame: LaneFrame) {
    if (frame.type === 'subscribe-failed') {
      throw new Error('Lane stream unavailable.')
    }
    if (frame.type === 'snapshot') {
      h.summary = frame.snapshot.summary
      if (frame.snapshot.state)
        h.lastState = frame.snapshot.state as unknown as Record<string, unknown>
      h.projection = projection(h)
      h.projection.settle(frame.snapshot.messages, frame.snapshot.state)
      for (const event of frame.snapshot.pending) h.projection.apply({ kind: 'event', event })
      for (const request of [...frame.snapshot.ui, ...frame.snapshot.dialogs])
        h.projection.apply({ kind: 'extension-ui', request })
      h.messageBytes = utf8Length(JSON.stringify(frame.snapshot.messages))
      h.resolve()
      resync(h)
    } else {
      const event = frame.event
      if (event.kind === 'pi') {
        h.projection.apply(event.push)
        deliver(h, event.push)
        if (event.push.kind === 'event' && event.push.event.type === 'message_end') {
          h.messageBytes += utf8Length(JSON.stringify(event.push.event.message))
          if (h.messageBytes > HOST_LIMITS.outboundFrameBytes) {
            reattach(h)
          }
        }
      } else if (event.kind === 'summary') h.summary = event.summary
      else if (event.kind === 'control') h.summary = { ...h.summary, control: event.control }
      else {
        h.projection.resolveDialog(event.dialogId)
        resync(h)
      }
    }
    // Pi pushes already have their own delivery bus. Only lane metadata changes
    // need a Host snapshot refresh (sidebar, control and attention).
    if (
      frame.type === 'snapshot' ||
      (frame.type === 'event' && (frame.event.kind === 'summary' || frame.event.kind === 'control'))
    )
      ports.changed()
  }
  function owned(windowId: number, id: string) {
    const h = handles.get(id)
    if (!h || h.window.id !== windowId) throw new Error(REMOTE_UNAVAILABLE)
    return h
  }
  function dispose(windowId: number, id: string) {
    const h = owned(windowId, id)
    h.unwatch()
    handles.delete(id)
    const target = focused.get(windowId)
    if (target?.hostId === h.hostId && target.laneId === h.laneId) focused.delete(windowId)
    if (h.hydration) clearTimeout(h.hydration.timer)
    h.reject(new Error('Lane closed.'))
  }
  async function open(
    window: RemoteWindow,
    hostId: string,
    laneId: string,
  ): Promise<LiveSessionInfo> {
    const c = connection(hostId)
    const summary = c.snapshot().lanes.find((lane) => lane.laneId === laneId)
    if (!summary) throw new Error('Lane unavailable.')
    let h = [...handles.values()].find(
      (h) => h.window.id === window.id && h.hostId === hostId && h.laneId === laneId,
    )
    if (!h) {
      if ([...handles.values()].filter((h) => h.window.id === window.id).length >= 64)
        throw new Error('Too many open remote lanes.')
      let resolve: () => void = () => {}
      let reject: (error: Error) => void = () => {}
      const ready = new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
      })
      void ready.catch(() => {})
      const info: LiveSessionInfo = {
        sessionId: `remote-${randomBytes(8).toString('hex')}`,
        target: { kind: 'remote', hostId },
        laneId,
        workspacePath: `host:${hostId}/lane:${laneId}`,
      }
      const handle: Handle = {
        info,
        window,
        hostId,
        laneId,
        summary,
        connection: c,
        projection: createLaneProjection({ now: Date.now, overflow: () => reattach(handle) }),
        unwatch: () => {},
        ready,
        resolve,
        reject,
        messageBytes: 0,
      }
      h = handle
      handles.set(info.sessionId, handle)
      try {
        h.unwatch = c.watchLane(laneId, (frame) => receive(handle, frame))
      } catch (error) {
        handles.delete(info.sessionId)
        reject(new Error('Lane unavailable.'))
        throw error
      }
    }
    const handle = h
    const timeout = setTimeout(() => handle.reject(new Error('Lane snapshot timed out.')), 30_000)
    try {
      await h.ready
    } catch (error) {
      if (handles.has(h.info.sessionId)) dispose(window.id, h.info.sessionId)
      throw error
    } finally {
      clearTimeout(timeout)
    }
    if (c.snapshot().capabilities.includes('sessions.control'))
      void mutate(hostId, laneId, { type: 'lane.markRead', upTo: h.summary.attention }).catch(
        () => {},
      )
    return structuredClone(h.info)
  }
  async function mutate(hostId: string, laneId: string | undefined, op: LaneOp) {
    const c = connection(hostId, true)
    const summary = laneId ? c.snapshot().lanes.find((l) => l.laneId === laneId) : undefined
    if (laneId && !summary) throw new Error('Lane unavailable.')
    const frame = {
      type: 'command',
      requestId: randomUUID(),
      laneId,
      fence: summary?.control.fence,
      op,
    }
    if (!parseClientFrame(JSON.stringify(frame)).ok) throw new Error('Invalid remote lane request.')
    const generation = c.incarnation().generation
    const result = await c.send(op, laneId, summary?.control.fence)
    if (
      ports.connection(hostId) !== c ||
      c.incarnation().generation !== generation ||
      c.snapshot().state !== 'ready' ||
      !c.snapshot().capabilities.includes('sessions.control')
    )
      throw new Error(REMOTE_UNAVAILABLE)
    if (
      op.type === 'lane.create' &&
      op.worktree?.fresh &&
      result.status === 'rejected' &&
      result.code === 'branch-exists'
    )
      throw new FreshBranchExists('branch-exists')
    const response = receiptResponse(op.type, result, ports.label(hostId))
    if (!response.success) throw new Error(response.error)
    return result
  }
  async function readCall(h: Handle, capability: HostCapability, method: string, params: unknown) {
    const c = connection(h.hostId)
    if (!c.snapshot().capabilities.includes(capability)) throw new Error(REMOTE_UNAVAILABLE)
    const generation = c.incarnation().generation
    let result
    try {
      result = await c.call(method, params)
    } catch {
      throw new Error(REMOTE_UNAVAILABLE)
    }
    if (
      handles.get(h.info.sessionId) !== h ||
      c.incarnation().generation !== generation ||
      !c.snapshot().lanes.some((l) => l.laneId === h.laneId) ||
      ports.connection(h.hostId) !== c ||
      c.snapshot().state !== 'ready' ||
      !c.snapshot().capabilities.includes(capability)
    )
      throw new Error(REMOTE_UNAVAILABLE)
    if (!result.ok)
      throw new Error(result.error.code === 'too-large' ? 'too-large' : REMOTE_UNAVAILABLE)
    return result.data
  }
  return {
    open,
    terminalLane(windowId: number, sessionId: string, workspace: string) {
      const h = owned(windowId, sessionId)
      if (workspace !== h.info.workspacePath) throw new Error(REMOTE_UNAVAILABLE)
      const c = h.connection
      return {
        hostId: h.hostId,
        laneId: h.laneId,
        connection: c,
        current: () =>
          handles.get(sessionId) === h &&
          h.connection === c &&
          c === ports.connection(h.hostId) &&
          c.snapshot().lanes.some((l) => l.laneId === h.laneId),
      }
    },
    readLane(windowId: number, key?: string): WriteLane | null {
      const target = focused.get(windowId)
      if (!target) {
        if (key?.startsWith('host:')) throw new Error(REMOTE_UNAVAILABLE)
        return null
      }
      const h = [...handles.values()].find(
        (h) => h.window.id === windowId && h.hostId === target.hostId && h.laneId === target.laneId,
      )
      if (
        !h ||
        (key !== undefined &&
          key !== h.info.sessionId &&
          key !== h.info.workspacePath &&
          !key.startsWith(`${h.info.workspacePath}/`))
      )
        throw new Error(REMOTE_UNAVAILABLE)
      return {
        laneId: h.laneId,
        workspacePath: h.info.workspacePath,
        async write(op) {
          const c = connection(h.hostId, true)
          const current = focused.get(windowId)
          const summary = c.snapshot().lanes.find((l) => l.laneId === h.laneId)
          if (
            !summary ||
            ports.connection(h.hostId) !== h.connection ||
            handles.get(h.info.sessionId) !== h ||
            current?.hostId !== h.hostId ||
            current.laneId !== h.laneId ||
            !c.snapshot().capabilities.includes('workspaces.write')
          )
            throw new Error(REMOTE_UNAVAILABLE)
          const receipt = await c.send(op, h.laneId, summary.control.fence)
          const after = focused.get(windowId)
          if (
            handles.get(h.info.sessionId) !== h ||
            ports.connection(h.hostId) !== c ||
            c.snapshot().state !== 'ready' ||
            !c.snapshot().lanes.some((lane) => lane.laneId === h.laneId) ||
            !c.snapshot().capabilities.includes('workspaces.write') ||
            !c.snapshot().capabilities.includes('sessions.control') ||
            after?.hostId !== h.hostId ||
            after.laneId !== h.laneId
          )
            throw new Error(REMOTE_UNAVAILABLE)
          if (receipt.status === 'rejected' && receipt.code === 'conflict')
            throw new Error('changed-on-disk')
          if (receipt.status !== 'done') throw new Error('File mutation not confirmed.')
          return receipt.data
        },
        async call(capability, method, params) {
          const focus = focused.get(windowId)
          const data = await readCall(h, capability, method, params)
          const current = focused.get(windowId)
          if (current !== focus || current?.hostId !== h.hostId || current.laneId !== h.laneId)
            throw new Error(REMOTE_UNAVAILABLE)
          return data
        },
      }
    },
    async create(window: RemoteWindow, hostId: string, input: RemoteLaneCreate) {
      // Do not carry Host error details or causes across IPC.
      const result = await mutate(hostId, undefined, {
        ...input,
        type: 'lane.create',
        worktree: input.worktree ?? null,
      }).catch((error: unknown) =>
        error instanceof FreshBranchExists ? 'branch-exists' : 'Lane creation not confirmed.',
      )
      if (typeof result === 'string') throw new Error(result)
      if (result.status !== 'done' || !result.laneId)
        throw new Error('Lane creation not confirmed.')
      return open(window, hostId, result.laneId)
    },
    async action(
      hostId: string,
      laneId: string,
      type: 'lane.stop' | 'lane.resume' | 'control.take' | 'control.release' | 'lane.markRead',
    ) {
      const c = connection(hostId, true)
      const summary = c.snapshot().lanes.find((l) => l.laneId === laneId)
      await mutate(
        hostId,
        laneId,
        type === 'lane.markRead' ? { type, upTo: summary?.attention ?? 0 } : { type },
      )
    },
    async command(windowId: number, id: string, command: RpcCommand): Promise<RpcResponse> {
      const h = owned(windowId, id)
      const base = { type: 'response' as const, command: command.type, id: command.id }
      const op = laneOperation(command)
      if (!op) return { ...base, success: false, error: REMOTE_UNAVAILABLE }
      try {
        const c = connection(h.hostId, typeof op !== 'string')
        if (command.type === 'get_state') {
          if (!h.hydration) {
            try {
              const result = await c.call('lane.state', { laneId: h.laneId })
              if (result.ok && record(result.data)) {
                const { sessionFile: _file, ...state } = result.data
                h.lastState = state
                return { ...base, success: true, data: { ...state, sessionId: id } }
              }
            } catch {
              // A stopped or unavailable Host keeps the last projected state usable.
            }
          }
          const state = h.hydration
            ? (h.hydration.view.state ?? h.lastState)
            : (h.lastState ?? h.projection.view().state)
          const summary = h.hydration?.summary ?? h.summary
          if (!state) return { ...base, success: false, error: 'Lane is stopped.' }
          const { sessionFile: _file, ...safe } = state
          return {
            ...base,
            success: true,
            data: {
              ...safe,
              sessionId: id,
              sessionName: summary.title ?? undefined,
              // Never relabel stale model metadata with a different model's ids.
              model:
                record(safe.model) &&
                (!summary.model ||
                  (safe.model.provider === summary.model.provider &&
                    safe.model.id === summary.model.id))
                  ? safe.model
                  : undefined,
              isStreaming: summary.activity === 'working',
              messageCount: (h.hydration?.view ?? h.projection.view()).messages.length,
            },
          }
        }
        if (command.type === 'get_messages') {
          // IPC replies hydrate first, then replay the unfinished turn and UI.
          const hydration = h.hydration
          if (hydration) {
            clearTimeout(hydration.timer)
            hydration.timer = setTimeout(() => {
              if (handles.has(id) && h.hydration === hydration) flush(h)
            }, 0)
          }
          return {
            ...base,
            success: true,
            data: { messages: (h.hydration?.view ?? h.projection.view()).messages },
          }
        }
        if (typeof op === 'string') {
          const result = await c.call(op, { laneId: h.laneId })
          let data: unknown = result.ok ? result.data : undefined
          if (op === 'lane.stats' && record(data)) {
            const { sessionFile: _file, ...stats } = data
            data = { ...stats, sessionId: id }
          }
          return result.ok
            ? { ...base, success: true, data }
            : { ...base, success: false, error: result.error.message }
        }
        if (
          (op.type === 'prompt' || op.type === 'steer' || op.type === 'follow_up') &&
          op.images?.length &&
          utf8Length(
            JSON.stringify({
              type: 'command',
              requestId: randomUUID(),
              laneId: h.laneId,
              fence: h.summary.control.fence,
              trace: randomBytes(8).toString('hex'),
              op,
            }),
          ) >
            HOST_LIMITS.inboundFrameBytes - 1024
        )
          return { ...base, success: false, error: 'Image too large for a remote lane.' }
        const result = await c.send(op, h.laneId, h.summary.control.fence)
        return { ...receiptResponse(command.type, result, ports.label(h.hostId)), id: command.id }
      } catch {
        return { ...base, success: false, error: REMOTE_UNAVAILABLE }
      }
    },
    async respond(windowId: number, id: string, response: ExtensionUIResponse) {
      const h = owned(windowId, id)
      await mutate(h.hostId, h.laneId, { type: 'extension_ui_response', response })
    },
    dispose,
    list: (windowId: number) =>
      [...handles.values()]
        .filter((h) => h.window.id === windowId)
        .map((h) => structuredClone(h.info)),
    setFocused(windowId: number, target: { hostId: string; laneId: string } | null) {
      if (target === null) {
        focused.delete(windowId)
        return
      }
      if (
        !target ||
        typeof target.hostId !== 'string' ||
        typeof target.laneId !== 'string' ||
        ![...handles.values()].some(
          (h) =>
            h.window.id === windowId && h.hostId === target.hostId && h.laneId === target.laneId,
        )
      )
        throw new Error('Lane unavailable.')
      focused.set(windowId, { hostId: target.hostId, laneId: target.laneId })
    },
    focused: (hostId: string, laneId: string, windowId: number) => {
      const target = focused.get(windowId)
      return target?.hostId === hostId && target.laneId === laneId
    },
    closeWindow(windowId: number) {
      focused.delete(windowId)
      for (const [id, h] of handles) if (h.window.id === windowId) dispose(windowId, id)
    },
    clear() {
      focused.clear()
      for (const [id, h] of handles) dispose(h.window.id, id)
    },
    reconcile() {
      for (const h of handles.values()) {
        if (!ports.present(h.hostId)) {
          dispose(h.window.id, h.info.sessionId)
          continue
        }
        const c = ports.connection(h.hostId)
        if (c && c !== h.connection) {
          h.unwatch()
          h.connection = c
          h.unwatch = c.watchLane(h.laneId, (frame) => receive(h, frame))
        }
      }
    },
  }
}
export type RemoteLanes = ReturnType<typeof createRemoteLanes>
