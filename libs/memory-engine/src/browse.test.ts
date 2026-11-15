import { expect, it } from 'vitest'
import { approve, fixture, lane } from './test-support'
import { entities, recent } from './browse'
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
  const all = entities(ctx, null, 0, 100)
  expect(all.items.length).toBeGreaterThan(2)
  expect(all.kinds).not.toContain('event')
  expect(all.items.some((item) => item.entity.id === 'empty')).toBe(false)
  const first = entities(ctx, null, 0, 1)
  const second = entities(ctx, null, 1, 1)
  expect(first.more).toBe(true)
  expect(second.items[0]).toEqual(all.items[1])
  const people = entities(ctx, 'person', 0, 100)
  expect(people.items.every((item) => item.entity.kind === 'person')).toBe(true)
  expect(people.more).toBe(false)
  db.exec("UPDATE memories SET state='superseded'")
  expect(entities(ctx, null, 0, 100)).toEqual(all)
})
it('returns current memories from finished jobs only and stops at twenty reads', () => {
  const { store, db, ctx } = setup()
  const initial = recent(ctx, 50)
  expect(initial.items.length).toBeGreaterThan(0)
  expect(initial.items[0]).toMatchObject({ originTitle: 'Harbor billing', type: 'procedure' })
  expect(initial.items[0]!.learnedAt).toBeTypeOf('number')
  expect(recent(ctx, 1).items).toEqual(initial.items.slice(0, 1))
  db.prepare("UPDATE memories SET state='superseded' WHERE id=?").run(initial.items[0]!.id)
  expect(recent(ctx, 50).items.some((m) => m.id === initial.items[0]!.id)).toBe(false)
  for (let i = 0; i < 20; i++) {
    const job = store.enqueue(lane({ sessionId: `ledger-${i}` }), 'queued')
    store.updateJob(job.id, { state: 'done', finishedAt: 100000 + i })
  }
  expect(recent(ctx, 50).items).toEqual([])
  db.exec('UPDATE memories SET job_id=NULL')
  expect(recent(ctx, 50).items).toEqual([])
})
it('uses the v5 indexes for the unfiltered browse, finished reads and per-job memories', () => {
  const { db } = setup()
  const plan = (sql: string) => JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all())
  expect(
    plan('SELECT id FROM entities WHERE memories>0 ORDER BY connections DESC,n ASC LIMIT 21'),
  ).toContain('entities_connections')
  expect(
    plan("SELECT id FROM jobs WHERE state='done' ORDER BY finished_at DESC LIMIT 20"),
  ).toContain('jobs_finished')
  expect(
    plan(
      "SELECT id FROM memories WHERE job_id='harbor' AND state IN ('active','disputed') ORDER BY recorded_at DESC,n DESC LIMIT 10",
    ),
  ).toContain('memories_job')
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 })
})
