import type { Context } from '../database'
import { entityNameCandidates } from './entity-name-candidates'
import { offer } from './suggestions'

export function sweepEntity(
  ctx: Context,
  id: string,
  preferredId?: string,
): { suggestions: number; capped: number } {
  const { buckets, capped } = entityNameCandidates(ctx, id)
  let suggestions = 0
  const seen = new Set<string>()
  for (const bucket of buckets) {
    // One representative per bucket keeps large clusters sparse, never a clique.
    const peer = bucket.find((match) => match.id === preferredId) ?? bucket[0]
    if (!peer || seen.has(peer.id)) continue
    seen.add(peer.id)
    if (offer(ctx, 'entity', id, peer.id, peer.reason)) suggestions++
  }
  return { suggestions, capped }
}
