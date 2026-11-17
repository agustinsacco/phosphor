import { all, one, type Context } from '../database'
import { fold, tokens } from '../text'

const NAME_LIMIT = 8
export const NAME_BUCKET_LIMIT = 16
interface NamedEntity {
  n: number
  id: string
  kind: string
  label: string
}
export interface EntityNameMatch extends NamedEntity {
  reason: string
  strength: number
}
interface Name {
  name: string
  folded: string
}

function names(ctx: Context, n: number): Name[] {
  return all<Name>(ctx, 'SELECT name,folded FROM entity_names WHERE entity=? ORDER BY n LIMIT 9', n)
}
function evidence(
  entity: NamedEntity,
  peer: NamedEntity,
  name: string,
  full?: string,
): EntityNameMatch {
  if (fold(entity.label) === fold(peer.label))
    return { ...peer, strength: 3, reason: `Both are named "${entity.label}".` }
  return full
    ? { ...peer, strength: 1, reason: `"${name}" is part of the name "${full}".` }
    : { ...peer, strength: 2, reason: `Both use the name "${name}".` }
}
/** Bounded indexed name probes, shared by entity and memory sweeps. */
export function entityNameCandidates(
  ctx: Context,
  id: string,
): { buckets: EntityNameMatch[][]; capped: number } {
  const entity = one<NamedEntity>(ctx, 'SELECT n,id,kind,label FROM entities WHERE id=?', id)
  if (!entity) return { buckets: [], capped: 0 }
  const ownNames = names(ctx, entity.n)
  let capped = Number(ownNames.length > NAME_LIMIT)
  const buckets: EntityNameMatch[][] = []
  for (const name of ownNames.slice(0, NAME_LIMIT)) {
    const probes = new Set([name.folded])
    if (entity.kind === 'person')
      for (const word of tokens(name.name).slice(0, NAME_LIMIT)) probes.add(word)
    for (const probe of probes) {
      const rows = all<NamedEntity & { name: string }>(
        ctx,
        'SELECT e.n,e.id,e.kind,e.label,n.name FROM (SELECT entity,name FROM entity_names WHERE folded=? ORDER BY entity LIMIT 17) n JOIN entities e ON e.n=n.entity',
        probe,
      )
      capped += Number(rows.length > NAME_BUCKET_LIMIT)
      buckets.push(
        rows
          .slice(0, NAME_BUCKET_LIMIT)
          .filter((peer) => peer.id !== id && peer.kind === entity.kind)
          .map((peer) =>
            evidence(
              entity,
              peer,
              probe === name.folded ? name.name : peer.name,
              probe === name.folded ? undefined : name.name,
            ),
          ),
      )
    }
    if (entity.kind !== 'person' || tokens(name.name).length !== 1) continue
    const word = tokens(name.name)[0]!
    const rows = all<NamedEntity>(
      ctx,
      'SELECT e.n,e.id,e.kind,e.label FROM (SELECT rowid FROM entity_words WHERE entity_words MATCH ? LIMIT 17) w JOIN entities e ON e.n=w.rowid',
      `"${word.replaceAll('"', '""')}"`,
    )
    capped += Number(rows.length > NAME_BUCKET_LIMIT)
    const matches: EntityNameMatch[] = []
    for (const peer of rows.slice(0, NAME_BUCKET_LIMIT)) {
      if (peer.id === id || peer.kind !== 'person') continue
      const full = names(ctx, peer.n)
        .slice(0, NAME_LIMIT)
        .find((r) => tokens(r.name).length > 1 && tokens(r.name).includes(word))
      if (full) matches.push(evidence(entity, peer, name.name, full.name))
    }
    buckets.push(matches)
  }
  // Every route to a pair uses its strongest evidence, independent of alias order.
  const strongest = new Map<string, EntityNameMatch>()
  for (const match of buckets.flat())
    if ((strongest.get(match.id)?.strength ?? 0) < match.strength) strongest.set(match.id, match)
  return {
    buckets: buckets.map((bucket) => bucket.map((match) => strongest.get(match.id)!)),
    capped,
  }
}
export function siblingEntities(
  ctx: Context,
  id: string,
): { items: EntityNameMatch[]; capped: number } {
  const result = entityNameCandidates(ctx, id)
  const items = [...new Map(result.buckets.flat().map((match) => [match.id, match])).values()].sort(
    (a, b) => b.strength - a.strength || a.n - b.n,
  )
  return {
    items: items.slice(0, NAME_BUCKET_LIMIT),
    capped: result.capped + Number(items.length > NAME_BUCKET_LIMIT),
  }
}
