import type { Context } from 'hono'
import {
  CONTROL_TRACE_HEADERS,
  isControlTrace,
  type HeartbeatRequest,
  type Readiness,
  type MachineState,
} from '@phosphor/shared/control-api'
import type { Env } from './http'

interface EventFields {
  enrollmentId?: string
  hostId?: string
  userId?: string
  hostname?: string
  platform?: string
  arch?: string
  hostVersion?: string | null
  keyFingerprint?: string | null
  label?: string
  state?: MachineState
  readiness?: Readiness
  result?: string
  reason?: string
}
export interface EventLog extends EventFields {
  ts: string
  level: 'info'
  event: string
  requestId: string
  trace: string | null
}
/** Accepted beats only. Restarting the server starts a new observation history. */
export class TraceEvents {
  private readonly beats = new Map<string, { at: number; state: string; readiness: string }>()
  constructor(
    private readonly clock: () => number,
    private readonly log: (entry: EventLog) => void,
  ) {}
  emit(c: Context<Env>, event: string, fields: EventFields): void {
    if (c.req.path === '/healthz' || c.req.header('user-agent')?.startsWith('kube-probe/')) return
    const trace = c.req.header(CONTROL_TRACE_HEADERS.trace)
    this.log({
      ts: new Date(this.clock()).toISOString(),
      level: 'info',
      event,
      requestId: c.get('requestId'),
      trace: isControlTrace(trace) ? trace : null,
      ...fields,
    })
  }
  accepted(c: Context<Env>, hostId: string, input: HeartbeatRequest): void {
    const at = this.clock()
    const previous = this.beats.get(hostId)
    const readiness = JSON.stringify(input.readiness)
    if (!previous || at - previous.at > 90_000) this.emit(c, 'host.connected', { hostId })
    if (previous && (previous.state !== input.state || previous.readiness !== readiness))
      this.emit(c, 'host.state', { hostId, state: input.state, readiness: input.readiness })
    this.beats.delete(hostId)
    if (this.beats.size >= 10_000) {
      const oldest = this.beats.keys().next().value
      if (oldest !== undefined) this.beats.delete(oldest)
    }
    this.beats.set(hostId, { at, state: input.state, readiness })
  }
  removed(c: Context<Env>, hostId: string, userId?: string): void {
    this.beats.delete(hostId)
    this.emit(c, 'host.removed', { hostId, ...(userId ? { userId } : {}) })
  }
}
