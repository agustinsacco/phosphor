import type { BrainStatus } from '@phosphor/shared/brain'
import type { BrainTidyMutation } from '@phosphor/shared/brain-tidy'
import type { BrainStore } from '@phosphor/memory-engine/types'
import type { BrainApi } from '../types'

export function tidyApi(
  store: BrainStore,
  status: () => BrainStatus,
  mutate: (run: () => void) => Promise<BrainStatus>,
): Pick<BrainApi, 'tidyChanges' | 'tidyUndo' | 'merge' | 'describe' | 'removeName' | 'split'> {
  /** A journaled change, with the operation its toast can undo. */
  const journaled = async (change: () => string | null): Promise<BrainTidyMutation> => {
    let operationId: string | null = null
    const result = await mutate(() => {
      operationId = change()
    })
    return { ...result, operationId }
  }
  return {
    tidyChanges: async (limit) => store.tidyChanges(limit),
    tidyUndo: async (id, revision) => mutate(() => store.tidyUndo(id, revision)),
    merge: async (source, target, revision) =>
      journaled(() => store.merge(source, target, revision)),
    describe: async (id, description, revision) =>
      journaled(() => store.describe(id, description, revision)),
    removeName: async (id, name, revision) => journaled(() => store.removeName(id, name, revision)),
    split: async (id, memoryIds, target, revision) =>
      journaled(() => store.split(id, memoryIds, target, revision)),
  }
}
