import type { AgentMessage } from '@shared/rpc'
import type { RoutineRunStatus } from '@shared/routines'

export interface RunOutcome {
  status: RoutineRunStatus
  reason: string
  summary?: string
}

/** A finished agent turn is not proof that a report or external write succeeded. */
export function outcomeForMessages(messages: AgentMessage[], toolErrors: boolean): RunOutcome {
  const last = messages.filter((m) => m.role === 'assistant').at(-1)
  if (!last || last.role !== 'assistant')
    return { status: 'failed', reason: 'No assistant result was received.' }
  if (last.errorMessage || last.stopReason === 'error' || last.stopReason === 'aborted') {
    return { status: 'failed', reason: last.errorMessage || `Agent stopped: ${last.stopReason}.` }
  }
  const summary = last.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .slice(-16000)
  if (!summary.trim())
    return {
      status: 'failed',
      reason:
        'The agent returned no written outcome. Inspect the lane before repeating any actions.',
    }
  return {
    status: 'finished',
    summary,
    reason: toolErrors
      ? 'Turn finished with tool errors. Outcome and external deliveries are unverified; inspect the lane.'
      : 'Agent turn finished. Outcome and external deliveries are unverified; review the lane.',
  }
}
