import { BRAIN_ENTITY_KINDS, type BrainEntityKind } from '@shared/brain'
import { formatCount } from '@/lib/format'
import { useBrain } from '../useBrain'
import { useBrainFind } from './BrainSearch'
import { useEntityPages } from './useEntityPages'
import type { EntitySort } from './entityIndex'
import type { BrainVisit } from './trail'

export interface IndexRow {
  visit: BrainVisit
  kind: BrainEntityKind | null
  /** The memory count shown at the row's end; empty for a memory row. */
  meta: string
}

/**
 * The index rows: a debounced search while there is a query, otherwise the browse pages for
 * one kind and sort. Both keep their own error and Retry.
 */
export function useIndexRows(query: string, kind: BrainEntityKind | '', sort: EntitySort) {
  const searching = !!query.trim()
  const find = useBrainFind(query)
  const browse = useEntityPages(kind || null, sort, !searching)
  const total = useBrain((s) => s.status?.counts.entities ?? 0)
  const entities: IndexRow[] = searching
    ? (find.data?.entities ?? [])
        .filter((entity) => !kind || entity.kind === kind)
        .map((entity) => ({
          visit: { kind: 'entity', id: entity.id, label: entity.label },
          kind: entity.kind,
          meta: String(entity.memories),
        }))
    : (browse.data?.items ?? []).map(({ entity, memories }) => ({
        visit: { kind: 'entity', id: entity.id, label: entity.label },
        kind: entity.kind,
        meta: String(memories),
      }))
  const memories: IndexRow[] = searching
    ? (find.data?.memories ?? []).map((memory) => ({
        visit: { kind: 'memory', id: memory.id, label: memory.summary },
        kind: null,
        meta: '',
      }))
    : []
  const counts = browse.data?.counts ?? {}
  const countAll = Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0) || total
  return {
    searching,
    entities,
    memories,
    rows: [...entities, ...memories],
    counts,
    countAll,
    kinds: BRAIN_ENTITY_KINDS.filter((k) => (browse.data?.kinds ?? []).includes(k)),
    resultLine: resultLine(
      searching,
      find.data ? entities.length + memories.length : null,
      browse.data,
    ),
    degradation: searching ? (find.data?.degradation ?? []) : [],
    error: searching ? find.error : browse.error,
    loaded: searching ? !!find.data : !!browse.data,
    retry: searching ? find.retry : browse.retry,
    more: !searching && !!browse.data?.more,
    onMore: browse.more,
  }
}

function resultLine(
  searching: boolean,
  found: number | null,
  browse: { total: number | null; items: unknown[]; more: boolean } | null,
): string {
  if (searching) return found === null ? 'Searching…' : formatCount(found, 'result')
  if (!browse) return 'Loading…'
  if (browse.total !== null) return formatCount(browse.total, 'result')
  return `${browse.items.length}${browse.more ? '+' : ''} shown`
}
