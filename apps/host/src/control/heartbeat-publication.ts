import { parseHeartbeatRequest, type HeartbeatRequest } from '@phosphor/shared/control-api'
import type { HeartbeatState } from './heartbeat'
import { IdentityFailure } from './identity'

export const PUBLICATION_WAIT_MS = 1000
export const REMOVED =
  'This machine was removed from your Phosphor account. Run phosphor setup to add it again.'

export function logHeartbeat(state: HeartbeatState, next: string): void {
  if (state.logState !== next) {
    state.logState = next
    state.ports.log(next)
  }
}

/** Serialize sequence publication even if a cancelled transport takes time to settle. */
export function publishHeartbeat(state: HeartbeatState, status: HeartbeatRequest['state']) {
  const { ports } = state
  const next = state.publication.then(async () => {
    state.last = Math.max(state.last, await ports.seq.read())
    const seq = Math.max(state.last + 1, ports.now())
    const parsed = parseHeartbeatRequest({
      seq,
      state: status,
      hostVersion: ports.hostVersion,
      uptimeSec: Math.max(0, Math.floor((ports.now() - state.started) / 1000)),
      readiness: state.readiness,
      lanes: { running: 0, waiting: 0 },
      endpoint: ports.endpoint?.() ?? null,
    })
    if (!parsed.ok) throw new IdentityFailure('Invalid heartbeat metadata.')
    await ports.seq.write(seq)
    state.last = seq
    return parsed.value
  })
  state.publication = next.then(
    () => {},
    () => {},
  )
  return next
}

async function finishPublication(state: HeartbeatState): Promise<void> {
  // The run lock is released after the drain. A sequence write already
  // running lands first, so the next run reads it; a stuck disk waits 1 s.
  // A second signal skips the wait: run's 3 s release wait must still cover
  // the API's 2 s close grace.
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    state.publication,
    state.forced,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PUBLICATION_WAIT_MS)
      timer.unref()
    }),
  ])
  clearTimeout(timer)
  logHeartbeat(state, 'stopped')
}

async function performDrain(state: HeartbeatState): Promise<{ state: 'stopped' }> {
  const deadline = new AbortController()
  try {
    await Promise.race([
      publishHeartbeat(state, 'stopping')
        .then((value) => state.ports.client(value, deadline.signal))
        .catch(() => {}),
      state.ports.wait(5000, deadline.signal).catch(() => {}),
      state.forced,
    ])
  } finally {
    deadline.abort()
    await finishPublication(state)
  }
  return { state: 'stopped' }
}

export async function drainHeartbeat(state: HeartbeatState): Promise<{ state: 'stopped' }> {
  if (state.drain) {
    state.force()
    return { state: 'stopped' }
  }
  state.ending = true
  state.running.abort()
  state.drain = performDrain(state)
  return state.drain
}
