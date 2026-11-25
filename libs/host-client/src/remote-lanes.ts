import { browserCrypto } from './crypto'
import { parseClientFrame, type LaneOp } from '@phosphor/shared/host-protocol'
import type { LiveSessionInfo } from '@phosphor/shared/models'
import type { ExtensionUIResponse, RpcCommand } from '@phosphor/shared/rpc'
import type { RemoteLaneCreate } from '@phosphor/shared/ipc'
import { createLaneProjection } from './projection'
import type { LaneRead } from './lane-reads'
import { laneCommand } from './lane-command'
import {
  reattach,
  receive,
  isStopped,
  type Handle,
  type Connection,
  type RemoteWindow,
} from './lane-stream'
export type { RemoteWindow } from './lane-stream'
import {
  createFailureText,
  laneActionOp,
  type LaneAction,
  REMOTE_UNAVAILABLE,
  settledReceipt,
} from './lane-ops'
import { remoteLaneKey, type HostCapability } from '@phosphor/shared/remote-host'
import type { WriteLane } from './ports'
import { HostReadFailure } from './read-features'
export function isRemoteHandle(id: string): boolean {
  return /^remote-[0-9a-f]{16}$/.test(id)
}

type LanePorts = {
  identity?: Pick<typeof browserCrypto, 'randomUUID' | 'randomHex'>
  connection: (hostId: string) => Connection | undefined
  present: (hostId: string) => boolean
  label: (hostId: string) => string
  changed: () => void
}

class RemoteLaneClient {
  constructor(private readonly ports: LanePorts) {}
  private get identity() {
    return this.ports.identity ?? browserCrypto
  }
  private readonly handles = new Map<string, Handle>()
  private readonly focusTargets = new Map<number, { hostId: string; laneId: string }>()

  private connection(hostId: string, control = false) {
    const c = this.ports.connection(hostId)
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
  private owned(windowId: number, id: string) {
    const h = this.handles.get(id)
    if (!h || h.window.id !== windowId) throw new Error(REMOTE_UNAVAILABLE)
    return h
  }
  dispose = (windowId: number, id: string) => {
    const h = this.owned(windowId, id)
    h.unwatch()
    this.handles.delete(id)
    const target = this.focusTargets.get(windowId)
    if (target?.hostId === h.hostId && target.laneId === h.laneId)
      this.focusTargets.delete(windowId)
    if (h.hydration) clearTimeout(h.hydration.timer)
    h.reject(new Error('Lane closed.'))
  }
  open = async (window: RemoteWindow, hostId: string, laneId: string): Promise<LiveSessionInfo> => {
    const c = this.connection(hostId)
    const summary = c.snapshot().lanes.find((lane) => lane.laneId === laneId)
    if (!summary) throw new Error('Lane unavailable.')
    let h = [...this.handles.values()].find(
      (h) => h.window.id === window.id && h.hostId === hostId && h.laneId === laneId,
    )
    if (!h) {
      if ([...this.handles.values()].filter((h) => h.window.id === window.id).length >= 64)
        throw new Error('Too many open remote lanes.')
      let resolve: () => void = () => {}
      let reject: (error: Error) => void = () => {}
      const ready = new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
      })
      void ready.catch(() => {})
      const info: LiveSessionInfo = {
        sessionId: `remote-${this.identity.randomHex(8)}`,
        target: { kind: 'remote', hostId },
        laneId,
        workspacePath: remoteLaneKey(hostId, laneId),
      }
      const handle: Handle = {
        info,
        window,
        hostId,
        laneId,
        summary,
        connection: c,
        changed: this.ports.changed,
        close: () => {
          if (this.handles.has(info.sessionId)) this.dispose(window.id, info.sessionId)
        },
        projection: createLaneProjection({ now: Date.now, overflow: () => reattach(handle) }),
        unwatch: () => {},
        ready,
        resolve,
        reject,
        messageBytes: 0,
      }
      h = handle
      this.handles.set(info.sessionId, handle)
      try {
        h.unwatch = c.watchLane(laneId, (frame) => receive(handle, frame))
      } catch (error) {
        this.handles.delete(info.sessionId)
        reject(new Error('Lane unavailable.'))
        throw error
      }
    }
    const handle = h
    const timeout = setTimeout(() => handle.reject(new Error('Lane snapshot timed out.')), 30_000)
    try {
      await h.ready
    } catch (error) {
      if (this.handles.has(h.info.sessionId)) this.dispose(window.id, h.info.sessionId)
      throw error
    } finally {
      clearTimeout(timeout)
    }
    if (c.snapshot().capabilities.includes('sessions.control'))
      void this.mutate(hostId, laneId, { type: 'lane.markRead', upTo: h.summary.attention }).catch(
        () => {},
      )
    return structuredClone(h.info)
  }
  private async mutate(hostId: string, laneId: string | undefined, op: LaneOp) {
    const c = this.connection(hostId, true)
    const summary = laneId ? c.snapshot().lanes.find((l) => l.laneId === laneId) : undefined
    if (laneId && !summary) throw new Error('Lane unavailable.')
    const frame = {
      type: 'command',
      requestId: this.identity.randomUUID(),
      laneId,
      fence: summary?.control.fence,
      op,
    }
    if (!parseClientFrame(JSON.stringify(frame)).ok) throw new Error('Invalid remote lane request.')
    const generation = c.incarnation().generation
    const result = await c.send(op, laneId, summary?.control.fence)
    if (
      this.ports.connection(hostId) !== c ||
      c.incarnation().generation !== generation ||
      c.snapshot().state !== 'ready' ||
      !c.snapshot().capabilities.includes('sessions.control')
    )
      throw new Error(REMOTE_UNAVAILABLE)
    return settledReceipt(op, result, this.ports.label(hostId))
  }
  private async readCall(h: Handle, capability: HostCapability, method: string, params: unknown) {
    const c = this.connection(h.hostId)
    if (!c.snapshot().capabilities.includes(capability)) throw new Error(REMOTE_UNAVAILABLE)
    const generation = c.incarnation().generation
    let result
    try {
      result = await c.call(method, params)
    } catch {
      throw new Error(REMOTE_UNAVAILABLE)
    }
    if (
      this.handles.get(h.info.sessionId) !== h ||
      c.incarnation().generation !== generation ||
      !c.snapshot().lanes.some((l) => l.laneId === h.laneId) ||
      this.ports.connection(h.hostId) !== c ||
      c.snapshot().state !== 'ready' ||
      !c.snapshot().capabilities.includes(capability)
    )
      throw new Error(REMOTE_UNAVAILABLE)
    if (!result.ok) throw new HostReadFailure(result.error.code)
    return result.data
  }
  terminalLane = (windowId: number, sessionId: string, workspace: string) => {
    const h = this.owned(windowId, sessionId)
    if (workspace !== h.info.workspacePath) throw new Error(REMOTE_UNAVAILABLE)
    const c = h.connection
    return {
      hostId: h.hostId,
      laneId: h.laneId,
      connection: c,
      current: () =>
        this.handles.get(sessionId) === h &&
        h.connection === c &&
        c === this.ports.connection(h.hostId) &&
        c.snapshot().lanes.some((l) => l.laneId === h.laneId),
    }
  }
  readLane = (windowId: number, key?: string): WriteLane | null => {
    const target = this.focusTargets.get(windowId)
    if (!target) {
      if (key?.startsWith('host:')) throw new Error(REMOTE_UNAVAILABLE)
      return null
    }
    const h = [...this.handles.values()].find(
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
      write: async (op) => {
        const c = this.connection(h.hostId, true)
        const current = this.focusTargets.get(windowId)
        const summary = c.snapshot().lanes.find((l) => l.laneId === h.laneId)
        if (
          !summary ||
          this.ports.connection(h.hostId) !== h.connection ||
          this.handles.get(h.info.sessionId) !== h ||
          current?.hostId !== h.hostId ||
          current.laneId !== h.laneId ||
          !c.snapshot().capabilities.includes('workspaces.write')
        )
          throw new Error(REMOTE_UNAVAILABLE)
        const receipt = await c.send(op, h.laneId, summary.control.fence)
        const after = this.focusTargets.get(windowId)
        if (
          this.handles.get(h.info.sessionId) !== h ||
          this.ports.connection(h.hostId) !== c ||
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
      call: async (capability, method, params) => {
        const focus = this.focusTargets.get(windowId)
        const data = await this.readCall(h, capability, method, params)
        const current = this.focusTargets.get(windowId)
        if (current !== focus || current?.hostId !== h.hostId || current.laneId !== h.laneId)
          throw new Error(REMOTE_UNAVAILABLE)
        return data
      },
    }
  }
  create = async (window: RemoteWindow, hostId: string, input: RemoteLaneCreate) => {
    // Do not carry Host error details or causes across IPC.
    const result = await this.mutate(hostId, undefined, {
      ...input,
      type: 'lane.create',
      worktree: input.worktree ?? null,
    }).catch(createFailureText)
    if (typeof result === 'string') throw new Error(result)
    if (result.status !== 'done' || !result.laneId) throw new Error('Lane creation not confirmed.')
    return this.open(window, hostId, result.laneId)
  }
  action = async (hostId: string, laneId: string, action: LaneAction) => {
    const summary = this.connection(hostId, true)
      .snapshot()
      .lanes.find((l) => l.laneId === laneId)
    await this.mutate(hostId, laneId, laneActionOp(action, summary?.attention ?? 0))
  }
  /** A read of a lane this window opened, answered by its Host; the reads are in lane-reads. */
  onLane = <T>(windowId: number, id: string, read: LaneRead<T>): Promise<T> => {
    const h = this.owned(windowId, id)
    return read(this.connection(h.hostId), h.laneId)
  }
  command = async (windowId: number, id: string, command: RpcCommand) =>
    laneCommand(this.owned(windowId, id), command, {
      identity: this.identity,
      label: this.ports.label,
      connection: (hostId, control) => this.connection(hostId, control),
      current: () => this.handles.has(id),
    })
  respond = async (windowId: number, id: string, response: ExtensionUIResponse) => {
    const h = this.owned(windowId, id)
    await this.mutate(h.hostId, h.laneId, { type: 'extension_ui_response', response })
  }
  list = (windowId: number) =>
    [...this.handles.values()]
      .filter((h) => h.window.id === windowId)
      .map((h) => structuredClone(h.info))
  setFocused = (windowId: number, target: { hostId: string; laneId: string } | null) => {
    if (target === null) {
      this.focusTargets.delete(windowId)
      return
    }
    if (
      !target ||
      typeof target.hostId !== 'string' ||
      typeof target.laneId !== 'string' ||
      ![...this.handles.values()].some(
        (h) => h.window.id === windowId && h.hostId === target.hostId && h.laneId === target.laneId,
      )
    )
      throw new Error('Lane unavailable.')
    this.focusTargets.set(windowId, { hostId: target.hostId, laneId: target.laneId })
  }
  focused = (hostId: string, laneId: string, windowId: number) => {
    const target = this.focusTargets.get(windowId)
    return target?.hostId === hostId && target.laneId === laneId
  }
  closeWindow = (windowId: number) => {
    this.focusTargets.delete(windowId)
    for (const [id, h] of this.handles) if (h.window.id === windowId) this.dispose(windowId, id)
  }
  clear = () => {
    this.focusTargets.clear()
    for (const [id, h] of this.handles) this.dispose(h.window.id, id)
  }
  reconcile = () => {
    for (const h of this.handles.values()) {
      if (!this.ports.present(h.hostId)) {
        this.dispose(h.window.id, h.info.sessionId)
        continue
      }
      const c = this.ports.connection(h.hostId)
      // A refused subscription sends no lane events. Watch the machine listing for Resume,
      // including when another device resumes a lane this window is only observing.
      const lane = h.previewUnavailable && c?.snapshot().lanes.find((l) => l.laneId === h.laneId)
      if (
        c &&
        (c !== h.connection || (h.previewUnavailable && lane && !isStopped(lane.activity)))
      ) {
        h.previewUnavailable = false
        h.unwatch()
        h.connection = c
        h.unwatch = c.watchLane(h.laneId, (frame) => receive(h, frame))
      }
    }
  }
}
export function createRemoteLanes(ports: LanePorts) {
  return new RemoteLaneClient(ports)
}
export type RemoteLanes = ReturnType<typeof createRemoteLanes>
