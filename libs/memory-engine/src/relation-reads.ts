import type { BrainLink } from '@phosphor/shared/brain'
import { all, type Context } from './database'
import { entityNumber } from './entities'

export const LINK = `CAST(r.n AS TEXT) AS id,s.id AS subjectId,r.predicate,o.id AS objectId,m.id AS memoryId,
  r.label,r.valid_from AS validFrom,r.valid_to AS validTo,r.stated_by AS statedBy`
export const ENDS =
  'JOIN entities s ON s.n=r.subject JOIN entities o ON o.n=r.object JOIN memories m ON m.n=r.memory'
export function endedLinks(ctx: Context, id: string, now: number): BrainLink[] {
  const n = entityNumber(ctx, id)
  return all(
    ctx,
    `SELECT ${LINK} FROM relations r ${ENDS} WHERE (r.subject=? OR r.object=?) AND r.valid_to<=? ORDER BY r.valid_to DESC,r.n DESC LIMIT 20`,
    n,
    n,
    now,
  )
}
