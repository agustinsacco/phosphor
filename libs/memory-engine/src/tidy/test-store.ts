import type { BrainTidyAction, BrainTidyKind } from '@phosphor/shared/brain-tidy'
import type { BrainStore } from '../types'
import type { Context } from '../database'
import { page, detail } from './reads'
import { apply } from './apply'
import { dismiss } from './suggestions'
import { afterOperation } from './hooks'

/** Tests exercise the same internal entry points after the manual Tidy UI is removed. */
export function suggestionTestStore(store: BrainStore, ctx: Context) {
  return Object.assign(store, {
    suggestions: (kind: BrainTidyKind | null, cursor: string | null, limit: number) =>
      page(ctx, kind, cursor, limit),
    suggestion: (id: string) => detail(ctx, id),
    applySuggestion: (id: string, action: BrainTidyAction, revision: number) => {
      const operation = apply(ctx, id, action, revision)
      afterOperation(ctx, operation)
      return operation
    },
    dismissSuggestion: (id: string, revision: number) => dismiss(ctx, id, revision),
  })
}
export type SuggestionTestStore = ReturnType<typeof suggestionTestStore>
