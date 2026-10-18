/**
 * Host protocol v1: the only language Desktop (and later the PWA) speaks to a
 * Host, over one WebSocket per client per Host, reached through Tailscale.
 *
 * The machine that runs a lane is its single ordering point. Every mutation is
 * a `command` with a client request id, admitted against the lane's control
 * fence and answered by exactly one durable receipt. Every change a viewer can
 * see arrives as an ordered `event` in that lane's stream, so all viewers flip
 * state at the same point (requirement R7).
 *
 * Pure module: no Node or DOM imports. Living contract: docs/remote-access.md
 * ("Host protocol"). This is the public entry; the declarations and parsers
 * live in ./host-protocol/.
 */
export type { LaneReceipt } from './lane-receipt'
export {
  HOST_API_PORT,
  HOST_API_ROUTES,
  HOST_CLOSE,
  HOST_LIMITS,
  HOST_PROTOCOL_VERSION,
  helloProofMessage,
  type HostCloseCode,
} from './host-protocol/constants'
export type {
  AttentionEvent,
  AttentionKind,
  LaneActivity,
  LaneControl,
  LaneController,
  LaneEvent,
  LanePiPush,
  LaneSnapshot,
  LaneSummary,
  RepositorySummary,
  StreamCursor,
} from './host-protocol/lanes'
export {
  CAPABILITY_FOR,
  HOST_CALL_METHODS,
  LANE_PI_OPS,
  UNFENCED_OPS,
  type CallError,
  type CallErrorCode,
  type FailureCode,
  type HostCallMethod,
  type LaneOp,
  type LaneOpType,
  type LanePiOp,
  type LanePiOpType,
  type Receipt,
  type RejectCode,
} from './host-protocol/operations'
export type { ClientFrame, ClientFrameParse, FrameSocket, HostFrame } from './host-protocol/frames'
export { isLaneBranchName, utf8Length } from './host-protocol/primitives'
export { parseClientFrame } from './host-protocol/client'

import { isUuid, isIsoTime, type Parsed } from './control-api'
import { parseTerminalFrame } from './host-protocol-terminals'
import { HOST_CAPABILITIES, HOST_PROTOCOL_VERSION, validateHostHello } from './remote-host'
import type { HostCapability } from './remote-host'
import type { AgentMessage, ExtensionUIRequest, PiEvent, RpcSessionState } from './rpc'
import { HOST_CLOSE, HOST_LIMITS, type HostCloseCode } from './host-protocol/constants'
import type {
  LaneControl,
  LaneEvent,
  LaneSnapshot,
  LaneSummary,
  RepositorySummary,
} from './host-protocol/lanes'
import type { CallErrorCode, Receipt, RejectCode } from './host-protocol/operations'
import type { HostFrame } from './host-protocol/frames'
import {
  cursor,
  frameId,
  hex,
  integer,
  isLaneBranchName,
  label,
  member,
  readJson,
  record,
  text,
  utf8Length,
} from './host-protocol/primitives'

// ---------- Host frame parser ----------

function capabilities(v: unknown): v is HostCapability[] {
  return (
    Array.isArray(v) &&
    v.length <= HOST_CAPABILITIES.length &&
    v.every((x) => member(x, HOST_CAPABILITIES)) &&
    new Set(v).size === v.length
  )
}
function control(v: unknown): LaneControl | null {
  if (!record(v) || !integer(v.fence, 1)) return null
  if (v.controller === null) return { fence: v.fence, controller: null }
  const c = v.controller
  return record(c) && isUuid(c.clientId) && label(c.label) && typeof c.connected === 'boolean'
    ? {
        fence: v.fence,
        controller: { clientId: c.clientId, label: c.label, connected: c.connected },
      }
    : null
}
function summary(v: unknown): LaneSummary | null {
  if (!record(v)) return null
  const c = control(v.control)
  if (
    !isUuid(v.laneId) ||
    !hex(v.repositoryId) ||
    !text(v.cwd, HOST_LIMITS.outboundFrameBytes) ||
    (v.title !== null && !label(v.title)) ||
    (v.branch !== null && !isLaneBranchName(v.branch)) ||
    typeof v.worktree !== 'boolean' ||
    (v.model !== null &&
      (!record(v.model) || !text(v.model.provider, 200) || !text(v.model.id, 200))) ||
    !member(v.activity, ['stopped', 'idle', 'working', 'needs-input', 'failed']) ||
    !isIsoTime(v.createdAt) ||
    !isIsoTime(v.updatedAt) ||
    !integer(v.attention) ||
    !integer(v.read) ||
    v.read > v.attention ||
    !c
  )
    return null
  return {
    laneId: v.laneId,
    repositoryId: v.repositoryId,
    cwd: v.cwd,
    title: v.title,
    branch: v.branch,
    worktree: v.worktree,
    model:
      record(v.model) && text(v.model.provider, 200) && text(v.model.id, 200)
        ? { provider: v.model.provider, id: v.model.id }
        : null,
    activity: v.activity,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    attention: v.attention,
    read: v.read,
    control: c,
  }
}
function list<T>(v: unknown, max: number, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: T[] = []
  for (const item of v) {
    const p = parse(item)
    if (p === null) return null
    out.push(p)
  }
  return out
}
function repository(v: unknown): RepositorySummary | null {
  return record(v) &&
    hex(v.id) &&
    text(v.name, HOST_LIMITS.outboundFrameBytes) &&
    text(v.path, HOST_LIMITS.outboundFrameBytes)
    ? { id: v.id, name: v.name, path: v.path }
    : null
}
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
function snapshot(v: unknown): LaneSnapshot | null {
  if (!record(v)) return null
  const c = cursor(v.cursor),
    s = summary(v.summary)
  if (!c || !s || (v.state !== null && !piState(v.state))) return null
  const messages = list(v.messages, HOST_LIMITS.outboundFrameBytes, (x) =>
    piMessage(x) ? x : null,
  )
  const pending = list(v.pending, HOST_LIMITS.pendingEvents, (x) => (piEvent(x) ? x : null))
  const dialogs = list(v.dialogs, HOST_LIMITS.outboundFrameBytes, (x) => (piDialog(x) ? x : null))
  const ui = list(v.ui, HOST_LIMITS.uiStatusKeys + HOST_LIMITS.uiWidgetKeys + 1, (x) =>
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
function event(v: unknown): LaneEvent | null {
  if (!record(v)) return null
  if (v.kind === 'control') {
    const c = control(v.control)
    return c ? { kind: v.kind, control: c } : null
  }
  if (v.kind === 'summary') {
    const s = summary(v.summary)
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
const rejects: readonly RejectCode[] = [
  'bad-request',
  'unsupported',
  'forbidden',
  'unknown-lane',
  'lane-stopped',
  'not-controller',
  'stale-fence',
  'conflict',
  'busy',
  'last-repository',
  'branch-exists',
  'too-many-requests',
]
const errors: readonly CallErrorCode[] = [
  'bad-request',
  'unsupported',
  'forbidden',
  'unknown-lane',
  'lane-stopped',
  'too-large',
  'internal',
]
function receipt(v: unknown): Receipt | null {
  if (!record(v) || !isUuid(v.requestId)) return null
  const requestId = v.requestId
  switch (v.status) {
    case 'pending':
    case 'unknown':
      return { requestId, status: v.status }
    case 'done':
      if (
        (v.fence !== undefined && !integer(v.fence, 1)) ||
        (v.laneId !== undefined && !isUuid(v.laneId))
      )
        return null
      try {
        if (
          v.data !== undefined &&
          utf8Length(JSON.stringify(v.data)) > HOST_LIMITS.receiptDataBytes
        )
          return null
      } catch {
        // Valid JSON can nest deeper than the serializer's stack allows.
        return null
      }
      return {
        requestId,
        status: v.status,
        ...(v.data !== undefined ? { data: v.data } : {}),
        ...(v.fence !== undefined ? { fence: v.fence } : {}),
        ...(v.laneId !== undefined ? { laneId: v.laneId } : {}),
      }
    case 'failed':
      return record(v.error) &&
        member(v.error.code, ['pi-error', 'timeout', 'internal']) &&
        text(v.error.message, HOST_LIMITS.messageChars)
        ? { requestId, status: v.status, error: { code: v.error.code, message: v.error.message } }
        : null
    case 'rejected': {
      const c = v.control === undefined ? undefined : control(v.control)
      return member(v.code, rejects) && c !== null
        ? { requestId, status: v.status, code: v.code, ...(c ? { control: c } : {}) }
        : null
    }
    default:
      return null
  }
}
export function parseHostFrame(s: string): Parsed<HostFrame> {
  const p = readJson(s, HOST_LIMITS.outboundFrameBytes)
  if (!p.ok) return p
  const v = p.value
  const good = (value: HostFrame): Parsed<HostFrame> => ({ ok: true, value })
  const bad = (): Parsed<HostFrame> => ({ ok: false, reason: 'host-frame' })
  if (typeof v.type === 'string' && v.type.startsWith('terminal.')) {
    const frame = parseTerminalFrame(v)
    return frame ? good(frame) : bad()
  }
  switch (v.type) {
    case 'ready': {
      if (
        !record(v.hello) ||
        !isUuid(v.hello.hostId) ||
        !hex(v.hello.runtimeEpoch) ||
        !capabilities(v.hello.capabilities)
      )
        return bad()
      const h = validateHostHello(v.hello, v.hello.hostId)
      if (
        !h.ok ||
        v.protocolVersion !== HOST_PROTOCOL_VERSION ||
        !text(v.proof, 86, 86) ||
        !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(v.proof) ||
        !hex(v.connectionId) ||
        !isIsoTime(v.grantExpiresAt) ||
        !record(v.client) ||
        !isUuid(v.client.id) ||
        !label(v.client.label) ||
        !capabilities(v.capabilities) ||
        !v.capabilities.every((c) => h.hello.capabilities.includes(c))
      )
        return bad()
      return good({
        type: v.type,
        protocolVersion: HOST_PROTOCOL_VERSION,
        hello: h.hello,
        proof: v.proof,
        connectionId: v.connectionId,
        grantExpiresAt: v.grantExpiresAt,
        client: { id: v.client.id, label: v.client.label },
        capabilities: v.capabilities,
      })
    }
    case 'auth-renewed':
      return isIsoTime(v.grantExpiresAt)
        ? good({ type: v.type, grantExpiresAt: v.grantExpiresAt })
        : bad()
    case 'lanes': {
      const c = cursor(v.cursor),
        r = list(v.repositories, HOST_LIMITS.repositoriesPerHost, repository),
        l = list(v.lanes, HOST_LIMITS.lanesPerHost, summary)
      return frameId(v.id) && c && r && l
        ? good({ type: v.type, id: v.id, cursor: c, repositories: r, lanes: l })
        : bad()
    }
    case 'routines-changed': {
      const c = cursor(v.cursor, 1)
      return frameId(v.id) &&
        c &&
        Object.keys(v).every((key) => ['type', 'id', 'cursor'].includes(key))
        ? good({ type: v.type, id: v.id, cursor: c })
        : bad()
    }
    case 'lanes-delta': {
      const c = cursor(v.cursor, 1),
        u = list(v.upsert, HOST_LIMITS.lanesPerHost, summary),
        r = list(v.remove, HOST_LIMITS.lanesPerHost, (x) => (isUuid(x) ? x : null))
      return frameId(v.id) && c && u && r
        ? good({ type: v.type, id: v.id, cursor: c, upsert: u, remove: r })
        : bad()
    }
    case 'attention': {
      const c = cursor(v.cursor, 1),
        e = v.event
      if (
        !frameId(v.id) ||
        !c ||
        !record(e) ||
        !isUuid(e.laneId) ||
        !integer(e.attention, 1) ||
        e.id !== `${e.laneId}:${e.attention}` ||
        !member(e.kind, [
          'finished',
          'needs-input',
          'failed',
          'routine-finished',
          'routine-paused',
        ]) ||
        !isIsoTime(e.at) ||
        (e.title !== null && !label(e.title))
      )
        return bad()
      return good({
        type: v.type,
        id: v.id,
        cursor: c,
        event: {
          id: e.id,
          laneId: e.laneId,
          kind: e.kind,
          attention: e.attention,
          at: e.at,
          title: e.title,
        },
      })
    }
    case 'snapshot': {
      const s = snapshot(v.snapshot)
      return frameId(v.id) &&
        isUuid(v.laneId) &&
        s &&
        s.summary.laneId === v.laneId &&
        typeof v.reset === 'boolean'
        ? good({ type: v.type, id: v.id, laneId: v.laneId, reset: v.reset, snapshot: s })
        : bad()
    }
    case 'event': {
      const c = cursor(v.cursor, 1),
        e = event(v.event)
      return frameId(v.id) &&
        isUuid(v.laneId) &&
        c &&
        e &&
        (e.kind !== 'summary' || e.summary.laneId === v.laneId)
        ? good({ type: v.type, id: v.id, laneId: v.laneId, cursor: c, event: e })
        : bad()
    }
    case 'subscribe-failed':
      return frameId(v.id) &&
        member(v.code, ['unknown-lane', 'too-many', 'forbidden', 'bad-request', 'too-large'])
        ? good({ type: v.type, id: v.id, code: v.code })
        : bad()
    case 'receipt': {
      const r = receipt(v.receipt)
      return r ? good({ type: v.type, receipt: r }) : bad()
    }
    case 'result':
      if (!frameId(v.id)) return bad()
      if (v.ok === true && 'data' in v)
        return good({ type: v.type, id: v.id, ok: true, data: v.data })
      return v.ok === false &&
        record(v.error) &&
        member(v.error.code, errors) &&
        text(v.error.message, HOST_LIMITS.messageChars)
        ? good({
            type: v.type,
            id: v.id,
            ok: false,
            error: { code: v.error.code, message: v.error.message },
          })
        : bad()
    case 'error':
      return typeof v.code === 'number' &&
        Object.values(HOST_CLOSE).some((x) => x === v.code) &&
        text(v.message, HOST_LIMITS.messageChars)
        ? good({ type: v.type, code: hostClose(v.code), message: v.message })
        : bad()
    case 'pong':
      return integer(v.at) ? good({ type: v.type, at: v.at }) : bad()
    default:
      return bad()
  }
}
function hostClose(code: number): HostCloseCode {
  for (const c of Object.values(HOST_CLOSE)) if (c === code) return c
  return HOST_CLOSE.badFrame
}
