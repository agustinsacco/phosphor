import { expect, it } from 'vitest'
import { approve, fixture } from './test-support'
import { entities } from './browse'
import type { Context } from './database'

function setup() {
  const { store, db } = fixture()
  approve(store)
  const ctx: Context = { db, now: () => 1000, id: () => 'made-up' }
  return { store, db, ctx }
}
it('browses by connections with paging, kind filtering and existing historical counts', () => {
  const { db, ctx } = setup()
  db.exec("INSERT INTO entities(id,label,kind,created_at) VALUES ('empty','Empty','event',1)")
  const all = entities(ctx, null, 0, 100, 'connected')
  expect(all.items.length).toBeGreaterThan(2)
  expect(all.kinds).not.toContain('event')
  expect(all.items.some((item) => item.entity.id === 'empty')).toBe(false)
  const first = entities(ctx, null, 0, 1, 'connected')
  const second = entities(ctx, null, 1, 1, 'connected')
  expect(first.more).toBe(true)
  expect(second.items[0]).toEqual(all.items[1])
  const people = entities(ctx, 'person', 0, 100, 'connected')
  expect(people.items.every((item) => item.entity.kind === 'person')).toBe(true)
  expect(people.more).toBe(false)
  db.exec("UPDATE memories SET state='superseded'")
  expect(entities(ctx, null, 0, 100, 'connected')).toEqual(all)
})
it('counts populated kinds whatever the filter, and totals the filtered entities', () => {
  const { db, ctx } = setup()
  db.exec("INSERT INTO entities(id,label,kind,created_at) VALUES ('empty','Empty','event',1)")
  const all = entities(ctx, null, 0, 1, 'connected')
  const expected = db
    .prepare('SELECT kind,COUNT(*) AS total FROM entities WHERE memories>0 GROUP BY kind')
    .all() as { kind: string; total: number }[]
  expect(all.counts).toEqual(Object.fromEntries(expected.map((row) => [row.kind, row.total])))
  expect(all.counts.event).toBeUndefined()
  expect(all.total).toBe(expected.reduce((sum, row) => sum + row.total, 0))
  const people = entities(ctx, 'person', 0, 1, 'name')
  expect(people.counts).toEqual(all.counts)
  expect(people.total).toBe(all.counts.person)
  expect(entities(ctx, 'event', 0, 1, 'recent')).toMatchObject({ items: [], total: 0 })
})
it('sorts by name without case, then id, and by newest current memory, with stable paging', () => {
  const { db, ctx } = setup()
  const ids = (sort: 'name' | 'recent') =>
    entities(ctx, null, 0, 100, sort).items.map((item) => item.entity.id)
  const labels = entities(ctx, null, 0, 100, 'name').items.map((i) => i.entity.label)
  expect(labels).toEqual([...labels].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())))
  const named = ids('name')
  db.prepare('UPDATE entities SET label=? WHERE id=?').run('aaa lowercase first', named.at(-1)!)
  expect(ids('name')[0]).toBe(named.at(-1))
  // The newest current memory decides; a superseded one does not count.
  const newest = (id: string) =>
    (
      db
        .prepare(
          "SELECT MAX(m.observed_at) AS t FROM mentions a JOIN memories m ON m.n=a.memory JOIN entities e ON e.n=a.entity WHERE e.id=? AND m.state IN ('active','disputed')",
        )
        .get(id) as { t: number | null }
    ).t
  const recentIds = ids('recent')
  const times = recentIds.map(newest)
  expect(times.filter((t) => t !== null)).toEqual(
    [...times.filter((t) => t !== null)].sort((a, b) => b! - a!),
  )
  const last = recentIds.at(-1)!
  db.prepare(
    'UPDATE memories SET observed_at=999999 WHERE n IN (SELECT a.memory FROM mentions a JOIN entities e ON e.n=a.entity WHERE e.id=?)',
  ).run(last)
  expect(ids('recent')[0]).toBe(last)
  db.prepare(
    "UPDATE memories SET state='superseded' WHERE n IN (SELECT a.memory FROM mentions a JOIN entities e ON e.n=a.entity WHERE e.id=?)",
  ).run(last)
  expect(ids('recent').at(-1)).toBe(last)
  for (const sort of ['connected', 'recent', 'name'] as const) {
    const whole = entities(ctx, null, 0, 100, sort).items
    const paged = whole.flatMap((_, i) => entities(ctx, null, i, 1, sort).items)
    expect(paged).toEqual(whole)
  }
})
it('uses the v5 indexes for the unfiltered browse', () => {
  const { db } = setup()
  const plan = (sql: string) => JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all())
  expect(
    plan('SELECT id FROM entities WHERE memories>0 ORDER BY connections DESC,n ASC LIMIT 21'),
  ).toContain('entities_connections')
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
})

it('walks the connection index for common and rare kinds, and finds kinds in one pass', () => {
  const { db } = setup()
  const plan = (sql: string) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
  for (const kind of ['project', 'event']) {
    const steps = plan(
      `SELECT id FROM entities WHERE memories>0 AND kind='${kind}' ORDER BY connections DESC,n ASC LIMIT 21`,
    )
    expect(JSON.stringify(steps)).toContain('entities_connections')
    expect(JSON.stringify(steps)).not.toContain('USE TEMP B-TREE FOR ORDER BY')
  }
  const kinds = plan('SELECT DISTINCT kind FROM entities WHERE memories>0')
  expect(kinds.filter((step) => String(step.detail).includes('SCAN entities'))).toHaveLength(1)
})
