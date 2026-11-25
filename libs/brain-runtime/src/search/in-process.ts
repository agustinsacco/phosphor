import type { BrainSearch } from '@phosphor/memory-engine/types'
import type { BrainSearchPort } from '../types'

/** Portable tests and non-Electron hosts can keep the reader in process. */
export function inProcessSearch(
  open: (path: string) => BrainSearch,
): (path: string) => BrainSearchPort {
  return (path) => {
    const search = open(path)
    return {
      refresh: () => search.refresh(),
      entities: async (kind, offset, limit, sort) => search.entities(kind, offset, limit, sort),
      resolve: async (names) => search.resolve(names),
      expand: async (input) => search.expand(input),
      routes: async (...args) => search.routes(...args),
      ready: async () => search.ready(),
      recall: async (input) => search.recall(input),
      find: async (query, vector, limit) => search.find(query, vector, limit),
      nearestEntities: async (vectors, k) => search.nearestEntities(vectors, k),
      nearestMemories: async (vectors, k) => search.nearestMemories(vectors, k),
      close: async () => search.close(),
    }
  }
}
