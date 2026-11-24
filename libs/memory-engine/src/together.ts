import type { BrainEntityView } from '@phosphor/shared/brain'
import { all, type Context } from './database'
import { entity } from './entities'

/** Count each current, unexpired shared memory once and leave out pairs already explained. */
export function togetherNames(
  ctx: Context,
  n: number,
  now: number,
): Pick<BrainEntityView, 'together' | 'togetherMore'> {
  const rows = all<{ id: string; shared: number; total: number }>(
    ctx,
    `WITH linked(other) AS (
    SELECT object FROM relations WHERE subject=? AND live=1 AND (valid_to IS NULL OR valid_to>?) UNION
    SELECT subject FROM relations WHERE object=? AND live=1 AND (valid_to IS NULL OR valid_to>?))
    SELECT e.id,COUNT(*) AS shared,COUNT(*) OVER () AS total FROM mentions a CROSS JOIN memories m ON m.n=a.memory
    CROSS JOIN mentions b ON b.memory=m.n CROSS JOIN entities e ON e.n=b.entity
    WHERE a.entity=? AND b.entity!=a.entity AND m.state!='superseded' AND (m.valid_to IS NULL OR m.valid_to>?)
    AND b.entity NOT IN (SELECT other FROM linked) GROUP BY b.entity ORDER BY shared DESC,e.label,e.id LIMIT 12`,
    n,
    now,
    n,
    now,
    n,
    now,
  )
  return {
    together: rows.map(({ id, shared }) => ({ entity: entity(ctx, id)!, shared })),
    togetherMore: (rows[0]?.total ?? 0) - rows.length,
  }
}
