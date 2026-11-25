import { HOST_LIMITS, utf8Length, type LaneSummary } from '@phosphor/shared/host-protocol'
import type { LiveSessionInfo, SessionPush } from '@phosphor/shared/models'
import type { createHostConnection, LaneFrame } from './connection'
import { createLaneProjection } from './projection'
export type Connection = ReturnType<typeof createHostConnection>
export interface RemoteWindow {
  id: number
  send: (channel: string, push: SessionPush) => void
  destroyed: () => boolean
}
export type Handle = {
  info: LiveSessionInfo
  window: RemoteWindow
  hostId: string
  laneId: string
  summary: LaneSummary
  projection: ReturnType<typeof createLaneProjection>
  connection: Connection
  previewUnavailable?: boolean
  changed: () => void
  close: () => void
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
function push(h: Handle, value: SessionPush) {
  if (!h.window.destroyed()) h.window.send(`pi:event:${h.info.sessionId}`, value)
}
export function reattach(h: Handle) {
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
export function flush(h: Handle) {
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
export function receive(h: Handle, frame: LaneFrame) {
  try {
    applyFrame(h, frame)
  } catch {
    h.reject(new Error('Lane stream unavailable.'))
    push(h, { kind: 'exit', code: null, signal: null, expected: false })
    h.close()
  }
}
function applyFrame(h: Handle, frame: LaneFrame) {
  if (frame.type === 'subscribe-failed') {
    const activity = h.connection
      .snapshot()
      .lanes.find((lane) => lane.laneId === h.laneId)?.activity
    if (frame.code !== 'too-large' || !isStopped(activity))
      throw new Error('Lane stream unavailable.')
    // Opening still returns a window-owned handle. Both shells surface the get_messages
    // refusal in chat during normal adoption, without inventing transcript messages.
    h.previewUnavailable = true
    h.projection = projection(h)
    h.resolve()
    resync(h)
    return
  }
  if (frame.type === 'snapshot') {
    h.previewUnavailable = false
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
    h.changed()
}

export function isStopped(activity: LaneSummary['activity'] | undefined) {
  return activity === 'stopped' || activity === 'failed'
}
