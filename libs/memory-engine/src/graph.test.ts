import { expect, it, vi } from 'vitest'
import { BRAIN_PREDICATES } from '@phosphor/shared/brain'
import { edges } from './graph'
import { fixture } from './test-support'

function graphFixture(hub = false) {
  const { db } = fixture()
  db.exec(`
    INSERT INTO entities(n,id,label,kind,created_at,connections) VALUES
      (1,'harbor','Harbor','project',1,${hub ? 201 : 40}),
      (2,'ledger','Ledger','project',1,40);
    INSERT INTO memories(n,id,summary,type,epistemic,scope,observed_at,recorded_at,state)
      VALUES (1,'memory','A supported link','fact','reported','/',1,1,'active');
  `)
  const insert = db.prepare(
    'INSERT INTO relations(memory,subject,predicate,object,live,observed_at) VALUES (1,?,?,?,1,?)',
  )
  for (const predicate of BRAIN_PREDICATES.slice(0, 2))
    for (const [subject, object] of [
      [1, 2],
      [2, 1],
    ])
      insert.run(subject!, predicate, object!, 1)
  // Different memories permit repeated links; ties break by relation rowid descending.
  for (let n = 2; n <= 10; n++) {
    db.prepare(
      "INSERT INTO memories(n,id,summary,type,epistemic,scope,observed_at,recorded_at,state) VALUES (?,?,'Link','fact','reported','/',1,1,'active')",
    ).run(n, `memory-${n}`)
    db.prepare(
      "INSERT INTO relations(memory,subject,predicate,object,live,observed_at) VALUES (?,1,'owns',2,1,1)",
    ).run(n)
  }
  return { db, now: () => 1, id: () => 'unused' }
}

it('keeps predicate/direction order, newest ties and eight links per predicate/direction', () => {
  for (const hub of [false, true]) {
    const ctx = graphFixture(hub)
    const links = edges(ctx, 'harbor')
    expect(links.map((link) => link.id)).toEqual([
      '13',
      '12',
      '11',
      '10',
      '9',
      '8',
      '7',
      '6',
      '2',
      '3',
      '4',
    ])
  }
})

it('reads ordinary entities in only two indexed relation queries', () => {
  const ctx = graphFixture()
  const queries: string[] = []
  const prepare = ctx.db.prepare.bind(ctx.db)
  vi.spyOn(ctx.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (sql.includes('FROM relations')) {
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        queries.push(sql)
        return all(...args)
      })
    }
    return statement
  })
  edges(ctx, 'harbor')
  expect(queries).toHaveLength(2)
  for (const sql of queries) {
    const plans = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1)
    expect(plans.some((row) => String(row.detail).includes('USING INDEX relations_'))).toBe(true)
    expect(plans.some((row) => String(row.detail).includes('SCAN r'))).toBe(false)
  }
})
