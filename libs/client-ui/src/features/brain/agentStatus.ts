import type { BrainAgentRun, BrainWaitingCounts } from '@shared/brain-agent'
import type { BrainStatus } from '@shared/brain'
import { formatCount } from '@/lib/format'

export function waitingCount(status: BrainStatus | null): number {
  return status ? Object.values(status.agent.waiting).reduce((sum, n) => sum + n, 0) : 0
}

export function waitingBreakdown(waiting: BrainWaitingCounts): string {
  const total = Object.values(waiting).reduce((sum, n) => sum + n, 0)
  return `${total} waiting: ${[
    waiting.reads && formatCount(waiting.reads, 'read'),
    waiting.entities && formatCount(waiting.entities, 'person or thing', 'people and things'),
    waiting.repeats && formatCount(waiting.repeats, 'repeat'),
    waiting.conflicts && formatCount(waiting.conflicts, 'disagreement'),
    waiting.flags && formatCount(waiting.flags, 'flag'),
  ]
    .filter(Boolean)
    .join(', ')}`
}

export function defragRefusal(status: BrainStatus): string | null {
  if (!status.prefs.enabled) return 'Turn Brain on in Settings first.'
  if (status.agent.run && ['queued', 'running'].includes(status.agent.run.state))
    return 'Defrag is already queued or running.'
  if (!waitingCount(status)) return 'Nothing is waiting for Defrag.'
  return null
}

export function agentResult(run: BrainAgentRun): string {
  return `Brain Agent decided ${formatCount(run.decided, 'thing')}${run.erased ? ` and erased ${run.erased}` : ''}`
}
