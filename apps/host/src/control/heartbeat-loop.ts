import { CONTROL_LIMITS, parseHeartbeatResponse } from '@phosphor/shared/control-api'
import { ControlFailure } from './client'
import type { HeartbeatState } from './heartbeat'
import { drainHeartbeat, logHeartbeat, publishHeartbeat, REMOVED } from './heartbeat-publication'
import { IdentityFailure } from './identity'

/**
 * `work`, or `fallback` once `signal` aborts. The abort listener is removed as
 * soon as either happens: the loop runs for the life of the service, so a race
 * against one long-lived promise would keep a reaction per beat (review r1).
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {})
    return Promise.resolve(fallback)
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => resolve(fallback)
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

async function runningBeat(state: HeartbeatState): Promise<number | null> {
  const { ports, running } = state
  if (ports.now() - state.refreshed >= 60_000) {
    state.readiness = await untilAborted(ports.readiness(), running.signal, state.readiness)
    state.refreshed = ports.now()
  }
  if (state.ending) return null
  const request = await publishHeartbeat(state, 'running')
  if (state.ending) return null
  const answer = await untilAborted(ports.client(request, running.signal), running.signal, null)
  if (state.ending || answer === null) return null
  const parsed = parseHeartbeatResponse(answer)
  if (!parsed.ok) throw new ControlFailure('internal')
  const jitter = ports.random()
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1)
    throw new IdentityFailure('Invalid heartbeat jitter.')
  const delay = parsed.value.nextInSec * 1000 + jitter * 3000
  state.backoff = 5000
  ports.onAccepted?.(parsed.value)
  logHeartbeat(state, 'connected')
  return delay
}

function retryDelay(state: HeartbeatState, error: ControlFailure): number {
  let delay: number
  if (error.code === 'conflict') {
    if (!state.staleLogged) {
      state.ports.log('Heartbeat sequence was stale; retrying.')
      state.staleLogged = true
    }
    delay = CONTROL_LIMITS.heartbeatMinSec * 1000
  } else if (error.code === 'too-many-requests') {
    delay = CONTROL_LIMITS.heartbeatMinSec * 1000
  } else {
    delay = state.backoff
    state.backoff = Math.min(state.backoff * 2, 300_000)
  }
  logHeartbeat(state, `retrying in ${delay / 1000}s`)
  return delay
}

export async function runHeartbeat(state: HeartbeatState): Promise<number> {
  const { ports, running } = state
  const abort = () => {
    void drainHeartbeat(state)
  }
  ports.signal?.addEventListener('abort', abort, { once: true })
  if (ports.signal?.aborted) void drainHeartbeat(state)
  state.backoff = 5000
  try {
    while (!state.ending) {
      let delay: number | null
      try {
        delay = await runningBeat(state)
        if (delay === null) break
      } catch (error) {
        if (state.ending) break
        if (!(error instanceof ControlFailure)) throw error
        if (error.code === 'gone') {
          ports.onRemoved?.()
          logHeartbeat(state, REMOVED)
          return 77
        }
        delay = retryDelay(state, error)
      }
      await untilAborted(
        ports.wait(delay, running.signal).catch(() => {}),
        running.signal,
        undefined,
      )
    }
    await state.drain
    return 0
  } finally {
    ports.signal?.removeEventListener('abort', abort)
  }
}
