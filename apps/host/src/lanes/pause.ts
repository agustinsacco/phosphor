import type { LanePause, LaneSummary } from '@phosphor/shared/host-protocol'
import {
  OWNER_LIMITS,
  type OwnerCalls,
  type ServicePauseState,
} from '@phosphor/shared/host-protocol-owner'
import type { HostReleaseFeature } from '@phosphor/shared/host-release'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { HostStore } from './store'
import type { LanePauseRow, LanePauseRows } from './store/pauses'

/** Refused while pausing or paused. Aborts, dialog replies and everything else still pass. */
export const PAUSE_REFUSED_OPS: readonly string[] = [
  'prompt',
  'steer',
  'follow_up',
  'lane.create',
  'lane.resume',
  'routine.run',
]
/** An admitted one of these ends the lane's stored pause: Continue. */
const CONTINUES: readonly string[] = ['prompt', 'steer', 'follow_up', 'lane.resume']

export const PAUSED_MESSAGE = 'Phosphor service is pausing for an update. Try again in a moment.'
/** How long a pause may wait for work to finish, and how long it may then stay paused. */
export const PAUSE_LIMIT_MS = OWNER_LIMITS.pauseDeadlineMs

/** A lane with a live pi process, and whether a turn is in flight (working or asking). */
export interface PausableLane {
  laneId: string
  sessionId: string
  working: boolean
}

export interface LanePausePorts {
  rows: Pick<LanePauseRows, 'list' | 'record' | 'remove'>
  liveLanes(): readonly PausableLane[]
  /** Routine runs in flight. */
  runningRoutines(): number
  /** The drain's abort-and-save step; answers the sessions whose turn was in flight. */
  abortTurns(): Promise<readonly string[]>
  /** These lanes' summaries changed (their `pause` came or went). */
  changed(laneIds: readonly string[]): void
  /** The pause ended: queued routine runs may start. */
  resumed(): void
  now(): number
  log(event: string, fields: Record<string, unknown>): void
  /** How often a pause looks again at what it waits for. */
  pollMs?: number
}

export type PauseOutcome = 'paused' | 'cancelled' | 'deadline'

/** Pausing every lane for a service update, and Continue. */
export interface LanePauses {
  state(): ServicePauseState
  /** Waits for turns, live sub-agent work and routine runs, up to `deadlineMs`; never aborts. */
  begin(purpose: 'update', deadlineMs?: number): Promise<PauseOutcome>
  /** Aborts and saves the turns in flight, then pauses. Nothing to do unless pausing. */
  abortNow(): Promise<ServicePauseState>
  cancel(): void
  admits(op: { readonly type: string }): boolean
  /** The lane's `pause` for its summary. */
  pauseFor(laneId: string): LanePause | undefined
  /** Live sub-agents a marker lane reported over the op channel (`lane.liveness`). */
  liveness(sessionId: string, subagents: number): void
  /** An admitted op on the lane: a prompt or resume ends its stored pause. */
  continued(laneId: string, op: { readonly type: string }): void
  close(): void
}

type Waiting = Extract<ServicePauseState, { kind: 'pausing' }>['waitingOn']
type Pausing = {
  kind: 'pausing'
  since: number
  deadline: number
  limitMs: number
  waitingOn: Waiting
  aborted: Set<string>
  settle(outcome: PauseOutcome): void
  done: Promise<PauseOutcome>
}
type Paused = { kind: 'paused'; since: number; laneIds: string[] }

const iso = (ms: number) => new Date(ms).toISOString()
/** No pause: also what `machine.local` reports while no lanes run. */
export const PAUSE_NONE: ServicePauseState = { kind: 'none' }
const NONE = PAUSE_NONE

class HostLanePauses implements LanePauses {
  private readonly stored: Map<string, LanePauseRow>
  private readonly subagents = new Map<string, number>()
  private shown = new Set<string>()
  private active: Pausing | Paused | null = null
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly ports: LanePausePorts) {
    this.stored = new Map(ports.rows.list().map((row) => [row.laneId, row]))
  }

  state(): ServicePauseState {
    const active = this.active
    if (!active) return NONE
    if (active.kind === 'paused')
      return { kind: 'paused', purpose: 'update', since: iso(active.since) }
    return {
      kind: 'pausing',
      purpose: 'update',
      since: iso(active.since),
      deadline: iso(active.deadline),
      waitingOn: { ...active.waitingOn },
    }
  }

  begin(_purpose: 'update', deadlineMs: number = PAUSE_LIMIT_MS): Promise<PauseOutcome> {
    if (this.active?.kind === 'pausing') return this.active.done
    if (this.active?.kind === 'paused') return Promise.resolve('paused')
    const since = this.ports.now()
    let settle: (outcome: PauseOutcome) => void = () => {}
    const done = new Promise<PauseOutcome>((resolve) => (settle = resolve))
    const limitMs = Math.min(Math.max(1, deadlineMs), PAUSE_LIMIT_MS)
    this.active = {
      kind: 'pausing',
      since,
      deadline: since + limitMs,
      limitMs,
      waitingOn: { turns: 0, subagents: 0, routines: 0 },
      aborted: new Set(),
      settle,
      done,
    }
    this.ports.log('pause.begin', { limitMs })
    this.timer = setInterval(() => this.check(), this.ports.pollMs ?? 250)
    this.timer.unref?.()
    this.check()
    return done
  }

  async abortNow(): Promise<ServicePauseState> {
    const pausing = this.active
    if (pausing?.kind !== 'pausing') return this.state()
    this.ports.log('pause.abort_now', { ...pausing.waitingOn })
    const ended = new Set(await this.ports.abortTurns())
    if (this.active !== pausing) return this.state()
    const lanes = this.ports.liveLanes()
    for (const lane of lanes) if (ended.has(lane.sessionId)) pausing.aborted.add(lane.laneId)
    this.enterPaused(pausing, lanes)
    return this.state()
  }

  cancel(): void {
    if (this.active) this.ports.log('pause.cancel', { kind: this.active.kind })
    this.end('cancelled')
  }

  admits(op: { readonly type: string }): boolean {
    return this.active === null || !PAUSE_REFUSED_OPS.includes(op.type)
  }

  pauseFor(laneId: string): LanePause | undefined {
    const row = this.stored.get(laneId)
    if (row) return { reason: 'service-update', at: iso(row.pausedAt) }
    if (this.active && this.shown.has(laneId))
      return { reason: 'service-update', at: iso(this.active.since) }
    return undefined
  }

  liveness(sessionId: string, subagents: number): void {
    if (Number.isSafeInteger(subagents) && subagents > 0) this.subagents.set(sessionId, subagents)
    else this.subagents.delete(sessionId)
  }

  continued(laneId: string, op: { readonly type: string }): void {
    if (this.active || !CONTINUES.includes(op.type) || !this.stored.has(laneId)) return
    try {
      this.ports.rows.remove([laneId])
    } catch {
      this.ports.log('pause.rows_failed', { action: 'remove' })
      return
    }
    this.stored.delete(laneId)
    this.ports.changed([laneId])
  }

  close(): void {
    this.clear()
    if (this.active?.kind === 'pausing') this.active.settle('cancelled')
    this.active = null
  }

  private clear() {
    // clearTimeout also clears an interval.
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Live lanes show the pause from memory while it lasts. */
  private show(laneIds: readonly string[]) {
    const next = new Set(laneIds)
    const moved = [...next, ...this.shown].filter((id) => next.has(id) !== this.shown.has(id))
    this.shown = next
    if (moved.length > 0) this.ports.changed(moved)
  }

  /** A failed look (the store closed under a drain, say) ends the pause rather than retrying. */
  private check() {
    try {
      this.look()
    } catch (error) {
      this.ports.log('pause.check_failed', { error: String(error) })
      this.end('cancelled')
    }
  }

  private look() {
    const pausing = this.active
    if (pausing?.kind !== 'pausing') return
    const lanes = this.ports.liveLanes()
    const sessions = new Set(lanes.map((lane) => lane.sessionId))
    for (const id of this.subagents.keys()) if (!sessions.has(id)) this.subagents.delete(id)
    pausing.waitingOn = {
      turns: lanes.filter((lane) => lane.working).length,
      subagents: [...this.subagents.values()].reduce((sum, n) => sum + n, 0),
      routines: this.ports.runningRoutines(),
    }
    this.show(lanes.map((lane) => lane.laneId))
    const { turns, subagents, routines } = pausing.waitingOn
    if (turns + subagents + routines === 0) return this.enterPaused(pausing, lanes)
    if (this.ports.now() < pausing.deadline) return
    // At the limit the pause is cancelled. Nothing is aborted without Abort now.
    this.ports.log('pause.deadline', { ...pausing.waitingOn })
    this.end('deadline')
  }

  private enterPaused(pausing: Pausing, lanes: readonly PausableLane[]) {
    const pausedAt = this.ports.now()
    const rows: LanePauseRow[] = lanes.map(({ laneId }) => ({
      laneId,
      pausedAt,
      was: pausing.aborted.has(laneId) ? 'aborted' : 'idle',
    }))
    try {
      this.ports.rows.record(rows)
      for (const row of rows) this.stored.set(row.laneId, row)
    } catch {
      // The rows only say "paused" after the restart; the pause itself still holds.
      this.ports.log('pause.rows_failed', { action: 'record' })
    }
    this.clear()
    this.active = { kind: 'paused', since: pausedAt, laneIds: rows.map((row) => row.laneId) }
    this.ports.log('pause.paused', { lanes: rows.length })
    this.show(lanes.map((lane) => lane.laneId))
    // A caller that never applies the update must not leave the machine refusing prompts.
    this.timer = setTimeout(() => {
      this.ports.log('pause.expired', { limitMs: pausing.limitMs })
      this.end('cancelled')
    }, pausing.limitMs)
    this.timer.unref?.()
    pausing.settle('paused')
  }

  private end(outcome: PauseOutcome) {
    const ending = this.active
    if (!ending) return
    this.active = null
    this.clear()
    if (ending.kind === 'paused') {
      try {
        this.ports.rows.remove(ending.laneIds)
      } catch {
        this.ports.log('pause.rows_failed', { action: 'remove' })
      }
      for (const laneId of ending.laneIds) this.stored.delete(laneId)
    }
    if (ending.kind === 'pausing') ending.settle(outcome)
    try {
      this.show([])
      this.ports.resumed()
    } catch (error) {
      this.ports.log('pause.end_failed', { error: String(error) })
    }
  }
}

export function createLanePauses(ports: LanePausePorts): LanePauses {
  return new HostLanePauses(ports)
}

/** The pause's ports over what `run` started: the store, live lanes, routines and runtime. */
export function hostLanePausePorts(parts: {
  store: Pick<HostStore, 'listLanes' | 'pauses'>
  live: {
    sessionFor(laneId: string): string | null
    summaryFor(laneId: string): LaneSummary | null
    republish(laneIds: readonly string[]): void
  }
  routines: { running(): number; resume(): void }
  runtime: { abortTurns(): Promise<readonly string[]> }
  now(): number
  log: RuntimeLog
}): LanePausePorts {
  const { store, live, routines, runtime } = parts
  return {
    rows: store.pauses,
    liveLanes: () =>
      store.listLanes().flatMap(({ laneId }) => {
        const sessionId = live.sessionFor(laneId)
        if (sessionId === null) return []
        const activity = live.summaryFor(laneId)?.activity
        return [
          { laneId, sessionId, working: activity === 'working' || activity === 'needs-input' },
        ]
      }),
    runningRoutines: () => routines.running(),
    abortTurns: () => runtime.abortTurns(),
    changed: (laneIds) => live.republish(laneIds),
    resumed: () => routines.resume(),
    now: parts.now,
    log: (event, fields) => parts.log('host', event, fields),
  }
}

/**
 * `machine.pause`. Long work answers at once: the caller follows the pause in
 * `machine.local`. Null `pauses`: the daemon runs no lanes yet (standby).
 */
export function answerPauseCall(
  pauses: LanePauses | null,
  params: OwnerCalls['machine.pause']['params'],
  log: (event: string, fields: Record<string, unknown>) => void,
): ServicePauseState | null {
  if (!pauses) return params.action === 'begin' ? null : NONE
  if (params.action === 'cancel') pauses.cancel()
  else if (params.action === 'abort-now')
    pauses.abortNow().catch((error: unknown) => log('pause.abort_failed', { error: String(error) }))
  else void pauses.begin(params.purpose, params.deadlineMs)
  return pauses.state()
}

/** What this service adds to `phosphor version --json`. */
export const FEATURE: HostReleaseFeature | null = 'service-pause'
