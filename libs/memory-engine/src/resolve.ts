import type { BrainEntitySummary } from '@phosphor/shared/brain'
import { all, one, type Context } from './database'
import { entity } from './entities'
import { fold } from './text'

function matches(ctx: Context, text: string) {
  const exact = entity(ctx, text)
  if (exact) return [exact]
  const index = text.lastIndexOf(':')
  return all<{ id: string }>(
    ctx,
    `SELECT e.id FROM entities e WHERE n IN (
    SELECT entity FROM entity_names WHERE folded=? UNION SELECT entity FROM entity_keys WHERE namespace=? AND value=?)
    ORDER BY memories DESC,label,id`,
    fold(text),
    index < 0 ? '' : text.slice(0, index),
    text.slice(index + 1),
  ).map(({ id }) => entity(ctx, id)!)
}
export function resolve(ctx: Context, names: string[]): BrainEntitySummary[][] {
  const groups = names.map((name) => matches(ctx, name.trim()))
  const now = ctx.now()
  return groups.map((group, i) => {
    if (group.length < 2) return group
    const others = JSON.stringify(groups.flatMap((g, j) => (i !== j && g[0] ? [g[0].id] : [])))
    const shared = (id: string) =>
      one<{ count: number }>(
        ctx,
        `SELECT COUNT(*) AS count FROM mentions a JOIN memories m ON m.n=a.memory
      JOIN mentions b ON b.memory=m.n WHERE a.entity=(SELECT n FROM entities WHERE id=?) AND a.entity!=b.entity
      AND b.entity IN (SELECT e.n FROM json_each(?) j JOIN entities e ON e.id=j.value)
      AND m.state!='superseded' AND (m.valid_to IS NULL OR m.valid_to>?)`,
        id,
        others,
        now,
      )!.count
    // Stable sort retains memory count, then label and id, when context gives no preference.
    return group
      .map((e) => ({ e, count: shared(e.id) }))
      .sort((a, b) => b.count - a.count)
      .map((row) => row.e)
  })
}
