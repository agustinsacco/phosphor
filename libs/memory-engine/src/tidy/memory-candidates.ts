import { all, one, type Context } from '../database'
import { cosine, decodeVector } from '../vectors'
import { siblingEntities } from './entity-name-candidates'

const ENTITY_MEMORY_WINDOW = 256
const MEMORY_CANDIDATE_LIMIT = 32
interface Candidate {
  n: number
  id: string
  scope: string
  branch: string | null
  vector: Float32Array
}
interface EntityWindow {
  items: Candidate[]
  capped: number
}
export interface MemoryCandidateCache {
  windows: Map<number, EntityWindow>
  siblings: Map<string, ReturnType<typeof siblingEntities>>
}
export function memoryCandidateCache(): MemoryCandidateCache {
  return { windows: new Map(), siblings: new Map() }
}
function entityWindow(ctx: Context, entity: number, cache: MemoryCandidateCache): EntityWindow {
  const saved = cache.windows.get(entity)
  if (saved) return saved
  // Numeric row order is insertion order; the mentions index bounds this lookup even for hubs.
  const rows = all<Omit<Candidate, 'vector'> & { state: string; vector: Uint8Array | null }>(
    ctx,
    `SELECT m.n,m.id,m.scope,m.branch,m.state,v.vector FROM (SELECT memory FROM mentions WHERE entity=? ORDER BY memory DESC LIMIT 257) a JOIN memories m ON m.n=a.memory LEFT JOIN memory_vectors v ON v.memory=m.n ORDER BY m.n DESC`,
    entity,
  )
  const result = {
    capped: Number(rows.length > ENTITY_MEMORY_WINDOW),
    items: rows
      .slice(0, ENTITY_MEMORY_WINDOW)
      .flatMap((row) =>
        row.vector && row.state !== 'superseded'
          ? [{ ...row, vector: decodeVector(row.vector) }]
          : [],
      ),
  }
  cache.windows.set(entity, result)
  return result
}
/** Score bounded recent windows, then share one best-32 budget across all mentioned identities. */
export function memoryCandidates(
  ctx: Context,
  n: number,
  cache: MemoryCandidateCache,
): { items: (Candidate & { score: number })[]; capped: number } {
  const vector = one<{ vector: Uint8Array }>(
    ctx,
    'SELECT vector FROM memory_vectors WHERE memory=?',
    n,
  )
  if (!vector) return { items: [], capped: 0 }
  const entities = all<{ n: number; id: string }>(
    ctx,
    'SELECT e.n,e.id FROM mentions a JOIN entities e ON e.n=a.entity WHERE a.memory=? ORDER BY e.memories,e.n LIMIT 5',
    n,
  )
  let capped = Number(entities.length > 4)
  const ids = new Set<number>()
  for (const entity of entities.slice(0, 4)) {
    ids.add(entity.n)
    let siblings = cache.siblings.get(entity.id)
    if (!siblings) {
      siblings = siblingEntities(ctx, entity.id)
      cache.siblings.set(entity.id, siblings)
    }
    capped += siblings.capped
    for (const peer of siblings.items) ids.add(peer.n)
  }
  const query = decodeVector(vector.vector)
  const seen = new Set<number>([n])
  const scored: (Candidate & { score: number })[] = []
  for (const entity of ids) {
    const window = entityWindow(ctx, entity, cache)
    capped += window.capped
    for (const peer of window.items) {
      if (seen.has(peer.n)) continue
      seen.add(peer.n)
      scored.push({ ...peer, score: cosine(query, peer.vector) })
    }
  }
  scored.sort((a, b) => b.score - a.score || b.n - a.n)
  return { items: scored.slice(0, MEMORY_CANDIDATE_LIMIT), capped }
}
