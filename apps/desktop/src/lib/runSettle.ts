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
export function createSettleTracker(): {
  /** True when `event` settles a run that ran to an end of its own. */
  finished: (sessionId: string, event: PiEvent) => boolean
  forget: (sessionId: string) => void
} {
  const running = new Set<string>()
  return {
    finished(sessionId, event) {
      if (event.type === 'agent_start') running.add(sessionId)
      if (event.type !== 'agent_settled') return false
      return running.delete(sessionId) && !event.aborted
    },
    forget: (sessionId) => void running.delete(sessionId),
  }
}
