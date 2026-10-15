import type { PiEvent } from '@shared/rpc'

/**
 * Which sessions just finished a run worth telling the user about.
 *
 * pi's `agent_settled` is its own "fully done", after retries, compaction
 * recovery and queued follow-ups, and since pi 1.1 it says whether the run was
 * aborted. A settle with no run since the last one (an extension command, a
 * reload) has nothing to report, and neither has an aborted run: only the stop
 * control aborts, so the user was already looking.
 */
export function createSettleTracker(now: () => number = Date.now): {
  finished: (sessionId: string, event: PiEvent) => boolean
  settle: (sessionId: string, event: PiEvent) => { finished: boolean; startedAt: number | null }
  forget: (sessionId: string) => void
} {
  const running = new Map<string, number>()
  function settle(sessionId: string, event: PiEvent) {
    if (event.type === 'agent_start' && !running.has(sessionId)) running.set(sessionId, now())
    if (event.type !== 'agent_settled') return { finished: false, startedAt: null }
    const startedAt = running.get(sessionId) ?? null
    const finished = running.delete(sessionId) && !event.aborted
    return { finished, startedAt }
  }
  return {
    settle,
    finished: (sessionId, event) => settle(sessionId, event).finished,
    forget: (sessionId) => void running.delete(sessionId),
  }
}
