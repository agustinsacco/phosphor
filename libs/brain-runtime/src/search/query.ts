import type {
  BrainExpansion,
  BrainQuery,
  BrainRoutes,
  BrainSearchResult,
} from '@phosphor/shared/brain-recall'
import type { BrainSearchPort, BrainServiceOptions } from '../types'

export function emptyExpansion(): BrainExpansion {
  return {
    mode: 'expand',
    status: 'no_match',
    entity: null,
    alternatives: [],
    current: [],
    ended: [],
    currentMore: [],
    together: [],
    togetherMore: 0,
    hits: [],
    entities: [],
    degradation: [],
  }
}
export function emptyRoutes(): BrainRoutes {
  return {
    mode: 'route',
    status: 'no_match',
    from: null,
    to: null,
    routes: [],
    memories: [],
    entities: [],
  }
}
export function unavailable(q: BrainQuery): BrainSearchResult {
  if (q.to) return { ...emptyRoutes(), status: 'unavailable' }
  if (q.from) return { ...emptyExpansion(), status: 'unavailable' }
  return {
    mode: 'search',
    status: 'unavailable',
    hits: [],
    entities: [],
    focus: [],
    more: 0,
    branch: null,
    degradation: [],
  }
}
/** Resolve all the names together: the worker ranks namesakes against the other names. */
export async function searchQuery(
  q: BrainQuery,
  options: BrainServiceOptions,
  search: BrainSearchPort,
  project: { scope: string | null; branch: string | null },
  enabled: () => boolean,
): Promise<BrainSearchResult> {
  const now = (options.now ?? Date.now)(),
    limit = q.limit ?? 8
  if (q.from) {
    const [matches = [], ...others] = await search.resolve([
      q.from,
      ...(q.to ? [q.to] : (q.context ?? [])),
    ])
    const [from, ...alternatives] = matches
    if (!enabled()) return unavailable(q)
    if (q.to) {
      const to = others[0]?.[0]
      return from && to
        ? search.routes(from.id, to.id, now)
        : { ...emptyRoutes(), from: from ?? null, to: to ?? null }
    }
    if (!from) return emptyExpansion()
    const result = await search.expand({
      entityId: from.id,
      contextIds: others.flatMap((m) => (m[0] ? [m[0].id] : [])),
      limit,
      now,
      ...project,
    })
    return { ...result, alternatives }
  }
  const query = q.query!
  const vector = await options.embeddings
    .embed([query], 'query')
    .then((rows) => (rows[0] ? new Float32Array(rows[0]) : null))
    .catch(() => null)
  if (!enabled()) return unavailable(q)
  return search.recall({ query, vector, ...project, now, limit })
}
