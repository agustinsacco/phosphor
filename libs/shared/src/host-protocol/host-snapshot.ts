/** Lane snapshots and lane events: one lane's state, then its ordered changes. */
import { isUuid } from '../control-api'
import type { AgentMessage, ExtensionUIRequest, PiEvent, RpcSessionState } from '../rpc'
import { HOST_LIMITS } from './constants'
import type { HostFrame } from './frames'
import { boundedList, parseLaneControl, parseLaneSummary } from './host-lanes'
import type { LaneEvent, LaneSnapshot } from './lanes'
import { cursor, frameId, integer, record, text } from './primitives'

type Frame<T extends HostFrame['type']> = Extract<HostFrame, { type: T }>

// pi payloads are deliberately shallow: rpc.ts owns their evolving inner shapes.
function piEvent(v: unknown): v is PiEvent {
  return record(v) && typeof v.type === 'string'
}
function piMessage(v: unknown): v is AgentMessage {
  return record(v) && typeof v.role === 'string'
}
function piDialog(v: unknown): v is ExtensionUIRequest {
  return (
    record(v) && v.type === 'extension_ui_request' && frameId(v.id) && typeof v.method === 'string'
  )
}
function piUi(v: unknown): v is ExtensionUIRequest {
  return (
    piDialog(v) && (v.method === 'setStatus' || v.method === 'setWidget' || v.method === 'setTitle')
  )
}
function piState(v: unknown): v is RpcSessionState {
  return record(v)
}

/** UI state is capped per kind: statuses, widgets, and a single title. */
export function parseLaneSnapshot(v: unknown): LaneSnapshot | null {
  if (!record(v)) return null
  const c = cursor(v.cursor),
    s = parseLaneSummary(v.summary)
  if (!c || !s || (v.state !== null && !piState(v.state))) return null
  const messages = boundedList(v.messages, HOST_LIMITS.outboundFrameBytes, (x) =>
    piMessage(x) ? x : null,
  )
  const pending = boundedList(v.pending, HOST_LIMITS.pendingEvents, (x) => (piEvent(x) ? x : null))
  const dialogs = boundedList(v.dialogs, HOST_LIMITS.outboundFrameBytes, (x) =>
    piDialog(x) ? x : null,
  )
  const ui = boundedList(v.ui, HOST_LIMITS.uiStatusKeys + HOST_LIMITS.uiWidgetKeys + 1, (x) =>
    piUi(x) ? x : null,
  )
  if (
    !ui ||
    ui.filter((request) => request.method === 'setStatus').length > HOST_LIMITS.uiStatusKeys ||
    ui.filter((request) => request.method === 'setWidget').length > HOST_LIMITS.uiWidgetKeys ||
    ui.filter((request) => request.method === 'setTitle').length > 1
  )
    return null
  return messages && pending && dialogs
    ? { cursor: c, summary: s, state: v.state, messages, pending, dialogs, ui }
    : null
}

/** Only event, extension-ui and exit pushes cross the wire; stderr never does. */
export function parseLaneEvent(v: unknown): LaneEvent | null {
  if (!record(v)) return null
  if (v.kind === 'control') {
    const c = parseLaneControl(v.control)
    return c ? { kind: v.kind, control: c } : null
  }
  if (v.kind === 'summary') {
    const s = parseLaneSummary(v.summary)
    return s ? { kind: v.kind, summary: s } : null
  }
  if (v.kind === 'dialog-resolved' && frameId(v.dialogId))
    return { kind: v.kind, dialogId: v.dialogId }
  if (v.kind !== 'pi' || !record(v.push)) return null
  const p = v.push
  if (p.kind === 'event' && piEvent(p.event))
    return { kind: v.kind, push: { kind: p.kind, event: p.event } }
  if (p.kind === 'extension-ui' && piDialog(p.request))
    return { kind: v.kind, push: { kind: p.kind, request: p.request } }
  if (
    p.kind === 'exit' &&
    (p.code === null || integer(p.code)) &&
    (p.signal === null || text(p.signal, 64)) &&
    typeof p.expected === 'boolean'
  )
    return {
      kind: v.kind,
      push: { kind: p.kind, code: p.code, signal: p.signal, expected: p.expected },
    }
  return null
}

/** A snapshot belongs to the frame's lane: its summary must name the same lane id. */
export function parseSnapshotFrame(v: Record<string, unknown>): Frame<'snapshot'> | null {
  const s = parseLaneSnapshot(v.snapshot)
  return frameId(v.id) &&
    isUuid(v.laneId) &&
    s &&
    s.summary.laneId === v.laneId &&
    typeof v.reset === 'boolean'
    ? { type: 'snapshot', id: v.id, laneId: v.laneId, reset: v.reset, snapshot: s }
    : null
}

/** A summary event belongs to the frame's lane; other events carry no lane id of their own. */
export function parseEventFrame(v: Record<string, unknown>): Frame<'event'> | null {
  const c = cursor(v.cursor, 1),
    e = parseLaneEvent(v.event)
  return frameId(v.id) &&
    isUuid(v.laneId) &&
    c &&
    e &&
    (e.kind !== 'summary' || e.summary.laneId === v.laneId)
    ? { type: 'event', id: v.id, laneId: v.laneId, cursor: c, event: e }
    : null
}
