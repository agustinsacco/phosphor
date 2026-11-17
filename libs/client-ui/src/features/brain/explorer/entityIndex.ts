import type { BrainEntityKind, BrainEntityPage } from '@shared/brain'

export type EntitySort = 'connected' | 'recent' | 'name'
export const ENTITY_SORT_LABELS: Record<EntitySort, string> = {
  connected: 'Most connected',
  recent: 'Recently learned',
  name: 'A to Z',
}
/** One page of the index, with counts per populated kind and the filter's total when known. */
export interface EntityIndexPage {
  items: BrainEntityPage['items']
  more: boolean
  kinds: BrainEntityKind[]
  counts: Partial<Record<BrainEntityKind, number>>
  total: number | null
}

export async function loadEntityIndex(
  kind: BrainEntityKind | null,
  offset: number,
  limit: number,
  sort: EntitySort,
): Promise<EntityIndexPage> {
  void sort
  const page = await window.phosphor.invoke('brain:entities', kind, offset, limit)
  return { ...page, counts: {}, total: null }
}
