import type { BrainWaitingCounts } from '@phosphor/shared/brain-agent'
import { all, one, type Context } from '../database'
import type { BrainAgentStore } from './types'

const notBuilt = (): never => {
  throw new Error('Brain Agent is not available in this build.')
}

export function waitingCounts(ctx: Context): BrainWaitingCounts {
  const reads = one<{ count: number }>(
    ctx,
    "SELECT COUNT(*) AS count FROM jobs WHERE state IN ('review','refreshing')",
  )!.count
  const counts: BrainWaitingCounts = { reads, entities: 0, repeats: 0, conflicts: 0, flags: 0 }
  const key = {
    same_entity: 'entities',
    same_memory: 'repeats',
    conflict: 'conflicts',
    flagged: 'flags',
  } as const
  for (const row of all<{ kind: string; count: number }>(
    ctx,
    "SELECT kind,COUNT(*) AS count FROM tidy_suggestions WHERE state='open' GROUP BY kind",
  ))
    if (Object.hasOwn(key, row.kind)) counts[key[row.kind as keyof typeof key]] = row.count
  return counts
}

export function agentStore(ctx: Context): BrainAgentStore {
  return {
    waitingCounts: () => waitingCounts(ctx),
    waitingSuggestions: notBuilt,
    agentSuggestion: notBuilt,
    decideRead: notBuilt,
    resolve: notBuilt,
    agentEdit: notBuilt,
    correct: notBuilt,
    erase: notBuilt,
    agentUndo: notBuilt,
    createRun: notBuilt,
    updateRun: notBuilt,
    latestRun: () => null,
    interruptRuns: () => undefined,
    undoRun: notBuilt,
  }
}
