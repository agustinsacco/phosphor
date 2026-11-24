/**
 * Machine reach, caller side: at most eight Host connections to sibling
 * machines, opened on first use with no `lanes` subscription, closed after
 * five idle minutes. They carry only `ops.run`. A connection that drops is
 * closed at once, so host-client never replays a write on it: an unanswered
 * write reads `unconfirmed`, and a read is tried once more on a new
 * connection. A target that closes 4403 is left alone for a minute.
 */
import {
  createHostConnection,
  hostEndpoint,
  type HostConnectionSnapshot,
} from '@phosphor/host-client/connection'
import { OPS_UNCONFIRMED, OPS_UNREADABLE, opsRun } from '@phosphor/host-client/ops'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import type { OpsRunRequest, OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { ReachResult } from '@phosphor/session-runtime/ops/reach'
import { nodeIdentity } from '@phosphor/session-runtime/pi/node-identity'
import { ReachGrantRefused, type ReachGrants } from './grants'

export const REACH_POOL_LIMITS = {
  open: 8,
  idleMs: 300_000,
  forbiddenBackoffMs: 60_000,
  connectMs: 15_000,
}
export type ReachPoolLimits = typeof REACH_POOL_LIMITS

export interface ReachTarget {
  readonly id: string
  readonly label: string
}

export interface ReachPoolPorts {
  readonly grants: Pick<ReachGrants, 'grantFor' | 'clear'>
  readonly socket: (url: string) => Promise<FrameSocket>
  readonly endpointAllowed?: (value: unknown) => boolean
  readonly now?: () => number
  readonly log?: RuntimeLog
  readonly limits?: Partial<ReachPoolLimits>
}

type Connection = ReturnType<typeof createHostConnection>
type Failure = Extract<ReachResult, { ok: false }>
interface Entry {
  readonly target: ReachTarget
  conn: Connection | null
  /** Null once the connection is ready; the refusal when it never will be. */
  ready: Promise<Failure | null>
  settle: (failure: Failure | null) => void
  busy: number
  used: number
  idle?: ReturnType<typeof setTimeout>
  dropped: boolean
}
type Attempt = { readonly result: ReachResult } | { readonly lost: true }

const refused = (code: Failure['code'], message: string): Failure => ({
  ok: false,
  code,
  message,
})

/** The target's own answer: confirmations and in-band denials keep the result as data. */
export function reachAnswer(result: OpsRunResult): ReachResult {
  if (result.status === 'ok') return { ok: true, data: result }
  if (result.status === 'confirm')
    return { ok: false, code: 'needs-confirm', message: result.title, data: result }
  return { ok: false, code: 'denied', message: result.text, data: result }
}

function grantRefusal(target: ReachTarget, error: unknown): Failure {
  const reason = error instanceof ReachGrantRefused ? error.reason : 'offline'
  switch (reason) {
    case 'signed-out':
      return refused(
        'forbidden',
        'This machine is not enrolled, so it cannot reach other machines.',
      )
    case 'reach-off':
      return refused(
        'forbidden',
        `Machine reach is off for ${target.label} or for this machine. Turn it on under Machines.`,
      )
    case 'unavailable':
      return refused(
        'offline',
        `${target.label} is offline, has no tailnet address, or runs a Phosphor too old for this.`,
      )
    case 'unknown':
      return refused('bad-request', `${target.label} is not one of your machines.`)
    case 'too-many-requests':
      return refused('denied', 'Too many machine grants this minute. Try again shortly.')
    default:
      return refused('offline', "Phosphor's control service cannot be reached right now.")
  }
}

function stateRefusal(target: ReachTarget, view: HostConnectionSnapshot): Failure {
  if (view.lastError === 'forbidden')
    return refused(
      'forbidden',
      `${target.label} refused this machine. Check that machine reach is on there; Phosphor waits a minute before trying again.`,
    )
  if (view.state === 'unsupported')
    return refused('unsupported', `Update that Host: ${target.label}.`)
  if (view.state === 'wrong-machine')
    return refused('forbidden', `${target.label} did not prove it is your enrolled machine.`)
  return refused('offline', `${target.label} is unreachable on your tailnet.`)
}

/** A failure once the request may have left: a write is never retried, a lost read once. */
function sendFailure(target: ReachTarget, error: unknown, write: boolean): Attempt {
  const message = error instanceof Error ? error.message : String(error)
  const result = (code: Failure['code'], text: string): Attempt => ({ result: refused(code, text) })
  if (message === 'Invalid agent op request.')
    return result('bad-request', 'That operation request is not valid.')
  if (write)
    return message === OPS_UNCONFIRMED || message === OPS_UNREADABLE
      ? result(
          'unconfirmed',
          `${target.label} did not confirm the change. Check it before you try again.`,
        )
      : result('offline', `${target.label} could not take the request.`)
  if (message === 'Connection closed.' || message === 'Connection unavailable.')
    return { lost: true }
  if (message === 'Query timed out.')
    return result('timeout', `${target.label} did not answer in time.`)
  if (message === OPS_UNREADABLE) return result('unsupported', `${target.label}: ${OPS_UNREADABLE}`)
  return result('offline', `${target.label} could not take the request.`)
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, stopped: T) {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(stopped)
  return new Promise<T>((resolve) => {
    const abort = () => resolve(stopped)
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve).finally(() => signal.removeEventListener('abort', abort))
  })
}

interface Pool {
  readonly ports: ReachPoolPorts
  readonly limits: ReachPoolLimits
  readonly now: () => number
  readonly entries: Map<string, Entry>
  /** Targets that closed 4403, and when they may be tried again. */
  readonly backoff: Map<string, number>
}

function drop(pool: Pool, entry: Entry) {
  if (entry.dropped) return
  entry.dropped = true
  if (pool.entries.get(entry.target.id) === entry) pool.entries.delete(entry.target.id)
  clearTimeout(entry.idle)
  entry.settle(refused('offline', `${entry.target.label} is unreachable on your tailnet.`))
  entry.conn?.close()
}

function changed(pool: Pool, entry: Entry) {
  const view = entry.conn?.snapshot()
  if (!view || entry.dropped || view.state === 'connecting') return
  if (view.state === 'ready') return entry.settle(null)
  if (view.lastError === 'forbidden') {
    pool.backoff.set(entry.target.id, pool.now() + pool.limits.forbiddenBackoffMs)
    pool.ports.grants.clear(entry.target.id)
  }
  entry.settle(stateRefusal(entry.target, view))
  // After host-client finishes its own close handling, so no retry timer outlives it.
  queueMicrotask(() => drop(pool, entry))
}

async function connect(pool: Pool, entry: Entry): Promise<void> {
  const { ports, limits } = pool
  const { id } = entry.target
  let endpoint: string | null
  try {
    endpoint = (await ports.grants.grantFor(id)).host.endpoint
  } catch (error) {
    entry.settle(grantRefusal(entry.target, error))
    return drop(pool, entry)
  }
  if (entry.dropped) return
  const timer = setTimeout(() => {
    entry.settle(refused('timeout', `${entry.target.label} is unreachable on your tailnet.`))
    drop(pool, entry)
  }, limits.connectMs)
  timer.unref()
  void entry.ready.finally(() => clearTimeout(timer))
  entry.conn = createHostConnection({
    identity: nodeIdentity,
    hostId: id,
    endpoint,
    endpointAllowed: ports.endpointAllowed ?? hostEndpoint,
    unrefTimer: (t) => t.unref(),
    socket: ports.socket,
    grant: () => ports.grants.grantFor(id),
    clearGrant: () => ports.grants.clear(id),
    changed: () => changed(pool, entry),
    lanes: false,
    log: ports.log,
  })
  changed(pool, entry)
}

function evictIdle(pool: Pool): boolean {
  let oldest: Entry | null = null
  for (const entry of pool.entries.values())
    if (entry.busy === 0 && (!oldest || entry.used < oldest.used)) oldest = entry
  if (oldest) drop(pool, oldest)
  return oldest !== null
}

function entryFor(pool: Pool, target: ReachTarget): Entry | Failure {
  const existing = pool.entries.get(target.id)
  if (existing) return existing
  if (pool.entries.size >= pool.limits.open && !evictIdle(pool))
    return refused(
      'denied',
      `Phosphor is already talking to ${pool.limits.open} machines. Try again shortly.`,
    )
  let settle: Entry['settle'] = () => {}
  const ready = new Promise<Failure | null>((resolve) => {
    settle = resolve
  })
  const entry: Entry = {
    target,
    conn: null,
    ready,
    settle,
    busy: 0,
    used: pool.now(),
    dropped: false,
  }
  pool.entries.set(target.id, entry)
  connect(pool, entry).catch(() => drop(pool, entry))
  return entry
}

function release(pool: Pool, entry: Entry) {
  entry.busy--
  entry.used = pool.now()
  if (entry.busy > 0 || entry.dropped) return
  entry.idle = setTimeout(() => drop(pool, entry), pool.limits.idleMs)
  entry.idle.unref()
}

async function attempt(
  pool: Pool,
  target: ReachTarget,
  request: OpsRunRequest,
  options: { readonly write: boolean; readonly signal?: AbortSignal },
): Promise<Attempt> {
  const until = pool.backoff.get(target.id)
  if (until !== undefined && pool.now() < until) {
    const message = `${target.label} refused this machine recently. Try again in a minute.`
    return { result: refused('forbidden', message) }
  }
  pool.backoff.delete(target.id)
  const entry = entryFor(pool, target)
  if (!('conn' in entry)) return { result: entry }
  entry.busy++
  clearTimeout(entry.idle)
  try {
    const stopped = refused('timeout', `Stopped before reaching ${target.label}.`)
    const failure = await abortable(entry.ready, options.signal, stopped)
    if (failure) return { result: failure }
    const conn = entry.conn
    if (!conn || entry.dropped) return { lost: true }
    if (conn.snapshot().ops !== true)
      return { result: refused('unsupported', `Update that Host: ${target.label}.`) }
    try {
      return { result: reachAnswer(await opsRun(conn, request, { write: options.write })) }
    } catch (error) {
      const outcome = sendFailure(target, error, options.write)
      if ('lost' in outcome) drop(pool, entry)
      return outcome
    }
  } finally {
    release(pool, entry)
  }
}

export function createReachPool(ports: ReachPoolPorts) {
  const pool: Pool = {
    ports,
    limits: { ...REACH_POOL_LIMITS, ...ports.limits },
    now: ports.now ?? Date.now,
    entries: new Map(),
    backoff: new Map(),
  }
  return {
    /** One op on one target. A read is tried once more after a lost connection; a write never. */
    async run(
      target: ReachTarget,
      request: OpsRunRequest,
      options: { readonly write: boolean; readonly signal?: AbortSignal },
    ): Promise<ReachResult> {
      for (let tries = 0; tries < 2; tries++) {
        const outcome = await attempt(pool, target, request, options)
        if ('result' in outcome) return outcome.result
      }
      return refused('offline', `${target.label} is unreachable on your tailnet.`)
    },
    /** How many sibling connections are open now. */
    size: () => pool.entries.size,
    close() {
      for (const entry of [...pool.entries.values()]) drop(pool, entry)
      pool.backoff.clear()
    },
  }
}

export type ReachPool = ReturnType<typeof createReachPool>
