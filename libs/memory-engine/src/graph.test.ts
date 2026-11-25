import { expect, it, vi } from 'vitest'
import { BRAIN_PREDICATES } from '@phosphor/shared/brain'
import { edges, GRAPH_LINKS } from './graph'
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

it('keeps predicate/direction order and one link per neighbour, the newest by rowid on ties', () => {
  for (const hub of [false, true]) {
    const ctx = graphFixture(hub)
    // Harbor owns Ledger is said ten times (1 and 5–13); only its newest link, 13, is kept.
    expect(edges(ctx, 'harbor').map((link) => link.id)).toEqual(['13', '2', '3', '4'])
  }
})

it('keeps the eight newest neighbours per predicate and direction', () => {
  for (const hub of [false, true]) {
    const { db } = fixture()
    db.exec(
      `INSERT INTO entities(n,id,label,kind,created_at,connections) VALUES (1,'harbor','Harbor','project',1,${hub ? 201 : 10})`,
    )
    for (let n = 2; n <= 11; n++) {
      db.prepare(
        "INSERT INTO entities(n,id,label,kind,created_at,connections) VALUES (?,?,'Project','project',1,1)",
      ).run(n, `project-${n}`)
      db.prepare(
        "INSERT INTO memories(n,id,summary,type,epistemic,scope,observed_at,recorded_at,state) VALUES (?,?,'Harbor owns it','fact','reported','/',?,?,'active')",
      ).run(n, `memory-${n}`, n, n)
      db.prepare(
        "INSERT INTO relations(memory,subject,predicate,object,live,observed_at) VALUES (?,1,'owns',?,1,?)",
      ).run(n, n, n)
    }
    const ctx = { db, now: () => 1, id: () => 'unused' }
    expect(edges(ctx, 'harbor').map((link) => link.objectId)).toEqual(
      [11, 10, 9, 8, 7, 6, 5, 4].map((n) => `project-${n}`),
    )
  }
})

/** Harbor owns Kestrel (said once, oldest) and Ledger (said nine times since). */
function repeatedPair(hub: boolean) {
  const { db } = fixture()
  db.exec(`
    INSERT INTO entities(n,id,label,kind,created_at,connections) VALUES
      (1,'harbor','Harbor','project',1,${hub ? 201 : 2}),
      (2,'ledger','Ledger','project',1,1),
      (3,'kestrel','Kestrel','project',1,1);
  `)
  const memory = db.prepare(
    "INSERT INTO memories(n,id,summary,type,epistemic,scope,observed_at,recorded_at,state) VALUES (?,?,'Harbor owns it','fact','reported','/',?,?,'active')",
  )
  const relation = db.prepare(
    "INSERT INTO relations(memory,subject,predicate,object,live,observed_at) VALUES (?,1,'owns',?,1,?)",
  )
  for (let n = 1; n <= 10; n++) {
    memory.run(n, `memory-${n}`, n, n)
    relation.run(n, n === 1 ? 3 : 2, n)
  }
  return { db, now: () => 1, id: () => 'unused' }
}

it('gives each neighbour one slot, so a pair said many times hides no other neighbour', () => {
  for (const hub of [false, true]) {
    const ctx = repeatedPair(hub)
    expect(edges(ctx, 'harbor').map((link) => link.objectId)).toContain('kestrel')
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
    const plans = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 1)
    expect(plans.some((row) => String(row.detail).includes('USING INDEX relations_'))).toBe(true)
    expect(plans.some((row) => String(row.detail).includes('SCAN r'))).toBe(false)
  }
})

/** A ring of projects, each using and depending on the next eight, every link said three times. */
function lattice(size: number) {
  const result = fixture()
  const { db } = result
  const entity = db.prepare(
    "INSERT INTO entities(n,id,label,kind,description,created_at,connections) VALUES (?,?,?,'project','',1,32)",
  )
  const memory = db.prepare(
    "INSERT INTO memories(n,id,summary,type,epistemic,scope,observed_at,recorded_at,state) VALUES (?,?,'Ring link','fact','reported','/',?,?,'active')",
  )
  const relation = db.prepare(
    'INSERT INTO relations(memory,subject,predicate,object,live,observed_at) VALUES (?,?,?,?,1,?)',
  )
  db.exec('BEGIN')
  for (let n = 1; n <= size; n++) entity.run(n, `project-${n}`, `Project ${n}`)
  let m = 0
  for (let n = 1; n <= size; n++)
    for (let step = 1; step <= 8; step++)
      for (const predicate of ['uses', 'depends_on'])
        for (let say = 0; say < 3; say++) {
          memory.run(++m, `memory-${m}`, m, m)
          relation.run(m, n, predicate, ((n + step - 1) % size) + 1, m)
        }
  db.exec('COMMIT')
  return result
}
const pairs = (links: { subjectId: string; predicate: string; objectId: string }[]) =>
  new Set(links.map((l) => `${l.subjectId} ${l.predicate} ${l.objectId}`)).size

it('sends one link per pair and predicate, the newest, from a neighbourhood', () => {
  const { store, db } = lattice(40)
  const graph = store.neighbourhood('project-1', 1, 300)
  expect(graph.nodes).toHaveLength(17)
  expect(graph.links.length).toBe(pairs(graph.links))
  const newest = db.prepare(
    'SELECT MAX(r.observed_at) AS t FROM relations r JOIN entities s ON s.n=r.subject JOIN entities o ON o.n=r.object WHERE s.id=? AND r.predicate=? AND o.id=?',
  )
  for (const link of graph.links)
    expect(store.memory(link.memoryId).memory.observedAt).toBe(
      (newest.get(link.subjectId, link.predicate, link.objectId) as { t: number }).t,
    )
})

it('caps a dense selection at GRAPH_LINKS links and says it was cut', () => {
  const { store } = lattice(250)
  const graph = store.overview(300)
  expect(graph.nodes).toHaveLength(250)
  expect(graph.links).toHaveLength(GRAPH_LINKS)
  expect(pairs(graph.links)).toBe(GRAPH_LINKS)
  expect(graph.truncated).toBe(true)
  expect(JSON.stringify(graph).length).toBeLessThan(400_000)
})
