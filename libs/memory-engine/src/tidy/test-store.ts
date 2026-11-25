import type { BrainTidyKind, BrainTidySuggestion } from '@phosphor/shared/brain-tidy'
import type { BrainStore } from '../types'
import { all, type Context } from '../database'
import { detail } from './reads'
import { COUNTED } from './suggestions'
import { publicCoverage } from './sweep'

/** Test reads of what Brain Agent would see: open suggestions, newest first, and coverage. */
export function suggestionTestStore(store: BrainStore, ctx: Context) {
  return Object.assign(store, {
    suggestions: (kind: BrainTidyKind | null): { items: BrainTidySuggestion[] } => ({
      items: all<{ id: string }>(
        ctx,
        `SELECT id FROM tidy_suggestions WHERE state='open' AND ${kind ? 'kind=?' : `kind IN (${COUNTED})`}
        ORDER BY created_at DESC,id DESC`,
        ...(kind ? [kind] : []),
      ).flatMap((row) => {
        const item = detail(ctx, row.id)?.suggestion
        return item?.state === 'open' ? [item] : []
      }),
    }),
    coverage: () => publicCoverage(ctx),
  })
}
export type SuggestionTestStore = ReturnType<typeof suggestionTestStore>
