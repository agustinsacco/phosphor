import { useCallback, useEffect, useState } from 'react'
import type { BrainEntityKind } from '@shared/brain'
import { useBrainResource } from '../useBrainResource'
import { loadEntityIndex, type EntityIndexPage, type EntitySort } from './entityIndex'

export const INDEX_PAGE = 30
const MAX_LIMIT = 100

/**
 * The index rows for one kind and sort, `shown` long. A change in Brain reloads the rows
 * already shown in one bounded pass, keeping the old rows on screen until the new ones land.
 */
export function useEntityPages(kind: BrainEntityKind | null, sort: EntitySort, enabled: boolean) {
  const [shown, setShown] = useState(INDEX_PAGE)
  useEffect(() => setShown(INDEX_PAGE), [kind, sort])
  const load = useCallback(async (): Promise<EntityIndexPage & { key: string }> => {
    let result: EntityIndexPage | null = null
    for (let offset = 0; offset < shown; offset += MAX_LIMIT) {
      const page = await loadEntityIndex(kind, offset, Math.min(MAX_LIMIT, shown - offset), sort)
      result = result ? { ...page, items: [...result.items, ...page.items] } : page
      if (!page.more) break
    }
    return { ...result!, key: `${kind}|${sort}` }
  }, [kind, sort, shown])
  const resource = useBrainResource(load, enabled)
  const [previous, setPrevious] = useState<(EntityIndexPage & { key: string }) | null>(null)
  useEffect(() => {
    if (resource.data) setPrevious(resource.data)
  }, [resource.data])
  const data = resource.data ?? (previous?.key === `${kind}|${sort}` ? previous : null)
  return {
    data,
    error: resource.error,
    retry: resource.retry,
    more: () => setShown((value) => value + INDEX_PAGE),
  }
}
