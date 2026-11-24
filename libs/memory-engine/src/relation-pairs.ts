export const INSTANT = 'instant(now) AS (VALUES(?))'
/** Probes about one (entity, neighbour) pair, shared by connection pages and the graph's edges. */
export type Side = 'subject' | 'object'
export const sideIndex = (side: Side): string =>
  side === 'subject' ? 'relations_out' : 'relations_in'
/**
 * A subquery about one (entity, neighbour) pair, run through the index of whichever side has
 * fewer connections. The outer query names the relation `r` and the neighbour `e`, and binds the
 * entity's own connection count once. The statement has one instant(now) CTE.
 */
export function pairProbe(
  own: Side,
  other: Side,
  query: (from: string, pair: string) => string,
): string {
  const pair = `x.${other}=r.${other} AND x.live=1 AND (x.valid_to IS NULL OR x.valid_to>(SELECT now FROM instant)) AND x.predicate=r.predicate AND x.${own}=r.${own}`
  const through = (side: Side) => query(`relations x INDEXED BY ${sideIndex(side)}`, pair)
  return `CASE WHEN e.connections<=? THEN (${through(other)}) ELSE (${through(own)}) END`
}
/** Not null when a newer live link joins the same pair through the same predicate. */
export function newerLink(own: Side, other: Side, extra = ''): string {
  return pairProbe(
    own,
    other,
    (from, pair) =>
      `SELECT 1 FROM ${from} WHERE ${pair} ${extra} AND x.observed_at>=r.observed_at AND (x.observed_at>r.observed_at OR x.n>r.n)`,
  )
}
