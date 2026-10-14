import { setTimeout as sleep } from 'node:timers/promises'
import type { PiEvent } from '@phosphor/shared/rpc'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import type { SessionRegistry } from '@phosphor/session-runtime/pi/session-registry'

export type HostState = 'booting' | 'validating' | 'ready' | 'draining' | 'stopped' | 'failed'

const MOVES: Record<HostState, readonly HostState[]> = {
  booting: ['validating', 'draining'],
  validating: ['ready', 'draining'],
  ready: ['draining'],
  draining: ['stopped', 'failed'],
  stopped: [],
  failed: [],
}

export interface Lifecycle {
  state: () => HostState
  /** Move forward. Any other move is a bug, so it throws. */
  to: (next: HostState) => void
  /** Only `ready` takes new work: a session start or a deletion. */
  assertReady: () => void
  /** From draining on, a running pi takes reads and interrupts only. */
  isDraining: () => boolean
}

export function createLifecycle(log: RuntimeLog): Lifecycle {
  let state: HostState = 'booting'
  return {
    state: () => state,
    to(next) {
      if (!MOVES[state].includes(next))
        throw new Error(`the Host cannot go from ${state} to ${next}`)
      log('host', 'state', { from: state, to: next })
      state = next
    },
    assertReady() {
      if (state !== 'ready') throw new Error(`the Host is ${state}: it takes no new work`)
    },
    isDraining: () => !['booting', 'validating', 'ready'].includes(state),
  }
}

export interface DrainTimings {
  /** How long a turn in flight gets to end after its abort. */
  abortMs: number
  /** From SIGTERM to SIGKILL, per session. */
  graceMs: number
  /** The whole drain, the final check included. Past it every group is killed and the Host fails. */
  deadlineMs: number
  /** How long the groups get to disappear once stopped, or once killed. */
  settleMs: number
}

export const DRAIN: DrainTimings = {
  abortMs: 5000,
  graceMs: 3000,
  deadlineMs: 15_000,
  settleMs: 1000,
}

export interface DrainResult {
  state: 'stopped' | 'failed'
  reason: string
  /** Sessions in the registry when the drain began. */
  sessions: number
  /** Turns aborted that ended, and so were saved, in time. */
  aborted: number
  /** Turns aborted that had not ended when the wait ran out: pi may not have saved them. */
  unfinished: number
  /** Why every group was killed outright: the deadline once it passed, else a second request. */
  forced: 'deadline' | 'hurried' | null
  /** Process groups still present at the end. Any one is a failure. */
  remaining: number[]
  errors: string[]
}

type TurnClient = Pick<PiRpcClient, 'alive' | 'request' | 'on' | 'off' | 'once' | 'dispose'>
export type TurnEnd = 'idle' | 'ended' | 'unfinished'
const POLL_MS = 20

/**
 * Abort a turn in flight and wait for it to end, since pi writes a reply to
 * the session file when it ends: stopping pi mid-reply would lose it.
 */
export async function endTurn(client: TurnClient, ms: number): Promise<TurnEnd> {
  if (!client.alive) return 'idle'
  const until = Date.now() + ms
  let ended = false
  let finish!: () => void
  const finished = new Promise<void>((resolve) => (finish = resolve))
  // Listen first: a turn can end between the state read and the abort.
  const onEvent = (event: PiEvent) => {
    if (event.type !== 'agent_end') return
    ended = true
    finish()
  }
  client.on('event', onEvent)
  client.once('exit', finish)
  try {
    const state = await within(client.request({ type: 'get_state' }), until)
    if (ended || !state?.success || !state.data?.isStreaming) return 'idle'
    await within(client.request({ type: 'abort' }), until)
    await within(finished, until)
    return ended ? 'ended' : 'unfinished'
  } finally {
    client.off('event', onEvent)
    client.off('exit', finish)
  }
}

/** End the turn in flight, then SIGTERM the group and SIGKILL it after the grace period. */
export async function stopSession(
  session: { sessionId: string; client: TurnClient },
  registry: Pick<SessionRegistry, 'dispose'>,
  timings: Pick<DrainTimings, 'abortMs' | 'graceMs'>,
): Promise<TurnEnd> {
  const turn = await endTurn(session.client, timings.abortMs)
  await session.client.dispose(timings.graceMs)
  await registry.dispose(session.sessionId)
  return turn
}

/** True once nothing is left in the group. EPERM means something still is. */
export function isGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export type ProcessGroups = ReturnType<typeof trackProcessGroups>

/**
 * Every process group this Host started that has not yet disappeared. The
 * system hands a number out again only once pi is reaped and its group has
 * no member left, and from pi's exit the group is checked every 20 ms until
 * it is gone. A reused number would have to come round within one check to
 * be counted here, or signalled by a forced drain.
 */
export function trackProcessGroups(registry: Pick<SessionRegistry, 'on'>) {
  const live = new Set<number>()
  const sweep = () => {
    for (const pgid of live) if (isGone(pgid)) live.delete(pgid)
  }
  registry.on('created', ({ client }) => {
    const pgid = client.pid
    // Never a child's pid, but signalled as a group, -1 would reach every
    // process this user may signal and -0 this Host's own group.
    if (pgid === undefined || pgid <= 1) return
    live.add(pgid)
    client.once('exit', () => {
      void (async () => {
        while (live.has(pgid) && !isGone(pgid)) await sleep(POLL_MS, undefined, { ref: false })
        live.delete(pgid)
      })()
    })
  })
  return {
    live: () => [...live],
    killAll() {
      for (const pgid of live) {
        try {
          process.kill(-pgid, 'SIGKILL')
        } catch {
          // Gone already.
        }
      }
    },
    /** The groups still present once they have had `ms` to disappear. */
    async remaining(ms: number): Promise<number[]> {
      const until = Date.now() + ms
      for (sweep(); live.size > 0 && Date.now() < until; sweep()) await sleep(POLL_MS)
      return [...live]
    },
  }
}

/**
 * Stop every session and make sure nothing is left. The deadline and a second
 * call each force the drain, at any point until it returns, the final check
 * included: every group is killed at once, and both calls get the same
 * result. Killed groups, and any stop still under way, then share one settle
 * window with the final check, so a drain returns within the deadline plus
 * that window. A cleanup error, the deadline or a group that will not go ends
 * in `failed`; anything else in `stopped`.
 */
export function createDrain(host: {
  life: Lifecycle
  registry: Pick<SessionRegistry, 'list' | 'get' | 'dispose'>
  groups: Pick<ProcessGroups, 'killAll' | 'remaining'>
  log: RuntimeLog
  timings: DrainTimings
}): (reason: string) => Promise<DrainResult> {
  const { life, registry, groups, log, timings } = host
  let current: Promise<DrainResult> | null = null
  // While a drain runs: kill every group now, and record why.
  let force: (cause: 'deadline' | 'hurried') => void = () => {}
  async function run(reason: string): Promise<DrainResult> {
    life.to('draining')
    const started = Date.now()
    const sessions = registry.list().flatMap((info) => registry.get(info.sessionId) ?? [])
    log('host', 'draining', { reason, sessions: sessions.length })
    const causes = new Set<'deadline' | 'hurried'>()
    let wake!: () => void
    const forced = new Promise<void>((resolve) => (wake = resolve))
    force = (cause) => {
      causes.add(cause)
      log('host', 'drain forced', { cause })
      groups.killAll()
      wake()
    }
    const timer = setTimeout(() => force('deadline'), timings.deadlineMs)
    try {
      const turns: TurnEnd[] = []
      const errors: string[] = []
      const work = Promise.all(
        sessions.map(async (session) => {
          try {
            turns.push(await stopSession(session, registry, timings))
          } catch (error) {
            errors.push(`${session.sessionId}: ${error instanceof Error ? error.message : error}`)
          }
        }),
      )
      await Promise.race([work, forced])
      const settled = Date.now() + timings.settleMs
      // A killed pi exits and its stop finishes; the final check gets what is left.
      if (causes.size > 0) await Promise.race([work, sleep(timings.settleMs)])
      const remaining = await groups.remaining(Math.max(0, settled - Date.now()))
      const deadline = causes.has('deadline')
      const failed = errors.length > 0 || deadline || remaining.length > 0
      const result: DrainResult = {
        state: failed ? 'failed' : 'stopped',
        reason,
        sessions: sessions.length,
        aborted: turns.filter((turn) => turn === 'ended').length,
        unfinished: turns.filter((turn) => turn === 'unfinished').length,
        forced: deadline ? 'deadline' : causes.has('hurried') ? 'hurried' : null,
        remaining,
        errors: [...errors],
      }
      log('host', 'drained', { ...result, ms: Date.now() - started })
      life.to(result.state)
      return result
    } finally {
      clearTimeout(timer)
      force = () => {}
    }
  }
  return (reason) => {
    if (current) {
      force('hurried')
      return current
    }
    current = run(reason)
    return current
  }
}

/** The promise's value, or undefined if it rejects or `until` passes first. */
async function within<T>(promise: Promise<T>, until: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, until - Date.now()))
  })
  try {
    return await Promise.race([promise.catch(() => undefined), late])
  } finally {
    clearTimeout(timer)
  }
}
