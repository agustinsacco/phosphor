import { all, type Context } from '../database'
import { tokens } from '../text'
import { offer } from './suggestions'

const BUCKET = 16
export function sweepEntity(ctx: Context, id: string): { suggestions: number; capped: number } {
  let suggestions = 0,
    capped = 0
  const entity = all<{ n: number; kind: string }>(
    ctx,
    'SELECT n,kind FROM entities WHERE id=?',
    id,
  )[0]
  if (!entity) return { suggestions, capped }
  const names = all<{ name: string; folded: string }>(
    ctx,
    'SELECT name,folded FROM entity_names WHERE entity=? ORDER BY n LIMIT 9',
    entity.n,
  )
  if (names.length > 8) capped++
  const seen = new Set<string>()
  for (const name of names.slice(0, 8)) {
    const probes = new Set([name.folded])
    if (entity.kind === 'person') for (const word of tokens(name.name).slice(0, 8)) probes.add(word)
    for (const probe of probes) {
      const rows = all<{ id: string; kind: string }>(
        ctx,
        'SELECT e.id,e.kind FROM (SELECT entity FROM entity_names WHERE folded=? ORDER BY entity LIMIT 17) n JOIN entities e ON e.n=n.entity',
        probe,
      )
      if (rows.length > BUCKET) capped++
      const peer = rows.slice(0, BUCKET).find((r) => r.id !== id && r.kind === entity.kind)
      if (peer && !seen.has(peer.id)) {
        seen.add(peer.id)
        if (
          offer(ctx, 'entity', id, peer.id, 'These records share a name or alias of the same kind.')
        )
          suggestions++
      }
    }
    if (entity.kind === 'person' && tokens(name.name).length === 1) {
      const word = tokens(name.name)[0]!
      const rows = all<{ id: string; kind: string; n: number }>(
        ctx,
        `SELECT e.id,e.kind,e.n FROM (SELECT rowid FROM entity_words WHERE entity_words MATCH ? LIMIT 17) w JOIN entities e ON e.n=w.rowid`,
        `"${word.replaceAll('"', '""')}"`,
      )
      if (rows.length > BUCKET) capped++
      for (const peer of rows.slice(0, BUCKET)) {
        if (peer.id === id || peer.kind !== 'person' || seen.has(peer.id)) continue
        const full = all<{ name: string }>(
          ctx,
          'SELECT name FROM entity_names WHERE entity=? LIMIT 8',
          peer.n,
        ).some((r) => tokens(r.name).length > 1 && tokens(r.name).includes(word))
        if (full) {
          seen.add(peer.id)
          if (
            offer(
              ctx,
              'entity',
              id,
              peer.id,
              'This one-word name is part of the other person’s full name.',
            )
          )
            suggestions++
          break
        }
      }
    }
  }
  return { suggestions, capped }
}
