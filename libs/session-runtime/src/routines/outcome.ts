import type { AgentMessage, AssistantMessage } from '@phosphor/shared/rpc'
import type { RoutineRunStatus } from '@phosphor/shared/routines'

export interface RunOutcome {
  status: RoutineRunStatus
  reason: string
  summary?: string
}

/**
 * How a run's last assistant message ended: `missing` when the run has none, `aborted`, `error`
 * (a provider or pi error, with or without `errorMessage`), or `ended` normally.
 */
export type AssistantEnd =
  { kind: 'missing' } | { kind: 'aborted' | 'error' | 'ended'; message: AssistantMessage }

/** The last assistant message of `messages` (an `agent_end`'s) and how it ended. */
export function lastAssistantEnd(messages: readonly AgentMessage[]): AssistantEnd {
  const last = messages.filter((m) => m.role === 'assistant').at(-1)
  if (!last || last.role !== 'assistant') return { kind: 'missing' }
  if (last.stopReason === 'aborted') return { kind: 'aborted', message: last }
  if (last.errorMessage || last.stopReason === 'error') return { kind: 'error', message: last }
  return { kind: 'ended', message: last }
}

/** A finished agent turn is not proof that a report or external write succeeded. */
export function outcomeForMessages(messages: AgentMessage[], toolErrors: boolean): RunOutcome {
  const end = lastAssistantEnd(messages)
  if (end.kind === 'missing')
    return { status: 'failed', reason: 'No assistant result was received.' }
  const last = end.message
  if (end.kind !== 'ended') {
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
