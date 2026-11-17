import type { BrainStatus } from '@phosphor/shared/brain'
import type { BrainApi } from '../types'
import type { TidyRunContext, TidyRunner } from './run'

export function tidyApi(
  { store }: TidyRunContext,
  runner: TidyRunner,
  status: () => BrainStatus,
  mutate: (run: () => void) => Promise<BrainStatus>,
): Pick<
  BrainApi,
  | 'tidy'
  | 'tidySuggestion'
  | 'tidyRun'
  | 'tidyCancel'
  | 'tidyApply'
  | 'tidyDismiss'
  | 'tidyChanges'
  | 'tidyUndo'
  | 'merge'
  | 'describe'
  | 'removeName'
  | 'split'
> {
  return {
    tidy: async (kind, cursor, limit) => ({
      ...store.tidy(kind, cursor, limit),
      run: runner.current(),
    }),
    tidySuggestion: async (id) => store.tidySuggestion(id),
    tidyRun: async () => {
      runner.start()
      return status()
    },
    tidyCancel: async () => {
      runner.cancel()
      return status()
    },
    tidyApply: async (id, action, revision) => {
      let operationId: string | null = null
      const result = await mutate(() => {
        operationId = store.tidyApply(id, action, revision)
      })
      return { ...result, operationId }
    },
    tidyDismiss: async (id, revision) => mutate(() => store.tidyDismiss(id, revision)),
    tidyChanges: async (limit) => store.tidyChanges(limit),
    tidyUndo: async (id, revision) => mutate(() => store.tidyUndo(id, revision)),
    merge: async (source, target, revision) => {
      let operationId: string | null = null
      const result = await mutate(() => {
        operationId = store.merge(source, target, revision)
      })
      return { ...result, operationId }
    },
    describe: async () => {
      throw new Error('Changing a description is not available yet.')
    },
    removeName: async () => {
      throw new Error('Removing a name is not available yet.')
    },
    split: async () => {
      throw new Error('Splitting a record is not available yet.')
    },
  }
}
