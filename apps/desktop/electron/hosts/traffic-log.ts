import type { ClientFrame, HostFrame } from '@shared/host-protocol'
import type { TrafficEntry, TrafficPage } from '@shared/ipc'

/**
 * Desktop's remote traffic, for the Machines debug log. Memory only, never
 * written to disk, and metadata only: frame kinds, method and op names, opaque
 * ids, sizes, timings and error codes. A payload never enters an entry, so the
 * auth grant, lane content, terminal input and output, and file contents
 * cannot leak through it. Every field is picked by name below; nothing copies a
 * frame or a log record wholesale.
 */
export const TRAFFIC_LIMIT = 2000
export const TRAFFIC_PAGE = 500
const OPEN_LIMIT = 512

type Draft = Omit<TrafficEntry, 'seq' | 'at'>
type Picked = Pick<TrafficEntry, 'kind' | 'detail' | 'ms' | 'outcome' | 'code'>

const short = (id: unknown): string => (typeof id === 'string' ? id.slice(0, 8) : '?')
/** A protocol word: method, op, event type or error code. Anything else is dropped. */
const word = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value) ? value : undefined
const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0)
const lane = (id: unknown): string => `lane ${short(id)}`

export function createTrafficLog(options: { now?: () => number; limit?: number } = {}) {
  const now = options.now ?? Date.now
  const limit = options.limit ?? TRAFFIC_LIMIT
  const entries: TrafficEntry[] = []
  let seq = 0
  // Requests waiting for their reply, so a result can name its method and time.
  const open = new Map<string, { at: number; label: string }>()
  function remember(key: string, label: string): void {
    open.set(key, { at: now(), label })
    if (open.size > OPEN_LIMIT) open.delete(open.keys().next().value ?? key)
  }
  function settle(key: string): { label?: string; ms?: number } {
    const request = open.get(key)
    open.delete(key)
    return request ? { label: request.label, ms: Math.max(0, now() - request.at) } : {}
  }
  function record(draft: Draft): void {
    entries.push({ ...draft, seq: ++seq, at: now() })
    if (entries.length > limit) entries.splice(0, entries.length - limit)
  }
  function outbound(frame: ClientFrame): Picked {
    switch (frame.type) {
      case 'auth':
        return { kind: 'auth', detail: frame.challenge ? 'handshake' : 'renew' }
      case 'subscribe':
        return {
          kind: 'subscribe',
          detail:
            frame.topic === 'lane'
              ? lane(frame.laneId)
              : frame.topic === 'terminal'
                ? `terminal ${short(frame.terminalId)}`
                : frame.topic,
        }
      case 'command': {
        const op = word(frame.op.type) ?? 'op'
        remember(`r:${frame.requestId}`, op)
        return { kind: 'command', detail: frame.laneId ? `${op} · ${lane(frame.laneId)}` : op }
      }
      case 'call': {
        const method = word(frame.method) ?? 'call'
        remember(`c:${frame.id}`, method)
        return { kind: 'call', detail: method }
      }
      case 'terminal.input':
        return { kind: 'terminal.input', detail: `terminal ${short(frame.terminalId)}` }
      default:
        return { kind: word(frame.type) ?? 'frame' }
    }
  }
  function inbound(frame: HostFrame): Picked {
    switch (frame.type) {
      case 'ready':
        return {
          kind: 'ready',
          detail: `Host ${word(frame.hello.hostVersion) ?? '?'} · ${count(frame.capabilities)} capabilities`,
          outcome: 'ok',
        }
      case 'pong': {
        const ms = now() - frame.at
        return { kind: 'pong', ms: ms >= 0 && ms < 600_000 ? ms : undefined }
      }
      case 'lanes':
        return {
          kind: 'lanes',
          detail: `${count(frame.lanes)} lanes · ${count(frame.repositories)} folders`,
        }
      case 'lanes-delta':
        return {
          kind: 'lanes-delta',
          detail: `${count(frame.upsert)} updated · ${count(frame.remove)} removed`,
        }
      case 'attention':
        return {
          kind: 'attention',
          detail: `${word(frame.event.kind) ?? '?'} · ${lane(frame.event.laneId)}`,
        }
      case 'snapshot':
        return {
          kind: 'snapshot',
          detail: `${lane(frame.laneId)}${frame.reset ? ' · reset' : ''}`,
        }
      case 'event': {
        const event = frame.event
        const type =
          event.kind === 'pi'
            ? event.push.kind === 'event'
              ? word(event.push.event.type)
              : word(event.push.kind)
            : word(event.kind)
        return { kind: 'event', detail: `${type ?? '?'} · ${lane(frame.laneId)}` }
      }
      case 'subscribe-failed':
        return { kind: 'subscribe-failed', outcome: 'error', code: word(frame.code) }
      case 'receipt': {
        const { label, ms } = settle(`r:${frame.receipt.requestId}`)
        const receipt = frame.receipt
        const code =
          receipt.status === 'failed'
            ? word(receipt.error.code)
            : receipt.status === 'rejected'
              ? word(receipt.code)
              : undefined
        return {
          kind: 'receipt',
          detail: `${label ?? 'command'} · ${receipt.status}`,
          ms,
          outcome:
            receipt.status === 'done'
              ? 'ok'
              : receipt.status === 'failed' || receipt.status === 'rejected'
                ? 'error'
                : undefined,
          code,
        }
      }
      case 'result': {
        const { label, ms } = settle(`c:${frame.id}`)
        return {
          kind: 'result',
          detail: label ?? 'call',
          ms,
          outcome: frame.ok ? 'ok' : 'error',
          code: frame.ok ? undefined : word(frame.error.code),
        }
      }
      case 'error':
        return { kind: 'error', outcome: 'error', code: String(frame.code) }
      case 'terminal.ack':
      case 'terminal.output':
      case 'terminal.reset':
      case 'terminal.exit':
        return { kind: frame.type, detail: `terminal ${short(frame.terminalId)}` }
      default:
        return { kind: word((frame as { type?: unknown }).type) ?? 'frame' }
    }
  }
  return {
    /** One frame Desktop sent or received. `bytes` is its encoded size. */
    frame(
      hostId: string,
      direction: 'in' | 'out',
      frame: ClientFrame | HostFrame,
      bytes: number,
    ): void {
      const picked =
        direction === 'out' ? outbound(frame as ClientFrame) : inbound(frame as HostFrame)
      record({ peer: 'host', hostId, direction, bytes, ...picked })
    },
    /**
     * Mirrors main's structured log lines for remote access (`control`,
     * `machines`, `hosts`), keeping only named, payload-free fields.
     */
    observe(scope: string, message: string, data?: unknown): void {
      const fields =
        data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      const hostId = typeof fields.hostId === 'string' ? fields.hostId : undefined
      if (scope === 'control' && message === 'call') {
        const status = typeof fields.status === 'number' ? fields.status : 0
        const code = word(fields.code)
        record({
          peer: 'control',
          direction: 'call',
          kind: `${word(fields.method) ?? 'GET'} ${typeof fields.route === 'string' ? fields.route.slice(0, 80) : '?'}`,
          ms: typeof fields.ms === 'number' ? fields.ms : undefined,
          outcome: code ? 'error' : 'ok',
          code: code ?? (status ? String(status) : undefined),
        })
        return
      }
      if (scope === 'machines' && message === 'observed') {
        record({
          peer: 'control',
          hostId,
          direction: 'state',
          kind: 'machine',
          detail: `${word(fields.from) ?? 'new'} → ${typeof fields.to === 'string' ? fields.to.slice(0, 20) : '?'}`,
        })
        return
      }
      if (scope === 'machines' || (scope === 'control' && message.startsWith('enrollment.'))) {
        record({ peer: 'control', direction: 'state', kind: word(message) ?? 'event' })
        return
      }
      // Receipts and ready already arrive as frames, with more detail.
      if (scope !== 'hosts' || message === 'receipt' || message === 'ready') return
      const detail =
        message === 'closed'
          ? `code ${typeof fields.code === 'number' ? fields.code : '?'}`
          : message === 'manager_replacement'
            ? word(fields.reason)
            : undefined
      record({
        peer: 'host',
        hostId,
        direction: 'state',
        kind: word(message) ?? 'event',
        detail,
        ms: message === 'closed' && typeof fields.ms === 'number' ? fields.ms : undefined,
        outcome: message === 'wrong-machine' || message === 'close_failed' ? 'error' : undefined,
      })
    },
    /** A lifecycle change that has no log line of its own, such as a user's reconnect. */
    state(hostId: string, kind: string, detail?: string): void {
      record({ peer: 'host', hostId, direction: 'state', kind, detail })
    },
    read(after: number): TrafficPage {
      const first = entries[0]?.seq ?? seq + 1
      const start = Math.max(0, Math.floor(after) - first + 1)
      const fresh = entries.slice(start)
      const page = fresh.slice(-TRAFFIC_PAGE)
      return {
        entries: page,
        last: seq,
        gap: (after > 0 && after < first - 1) || fresh.length > page.length,
      }
    },
  }
}

export type TrafficLog = ReturnType<typeof createTrafficLog>
/** The app's one traffic log. Main records into it; `hosts:traffic` reads it. */
export const trafficLog = createTrafficLog()
