import { expect, it } from 'vitest'
import { BRAIN_ENTITY_KINDS } from '@phosphor/shared/brain'
import { fixture } from './test-support'
import { recentEntities } from './browse'
import type { Context } from './database'

/** The sort's definition, which reads every listed entity's mentions; used here as the oracle. */
const ORACLE = `SELECT n FROM entities WHERE memories>0 AND (? IS NULL OR kind=?)
  ORDER BY (SELECT MAX(m.observed_at) FROM mentions a JOIN memories m ON m.n=a.memory
    WHERE a.entity=entities.n AND m.state IN ('active','disputed')) DESC NULLS LAST,n`

/** Made-up entities and memories with repeated timestamps, all three states and stale counts. */
function brain(seed: number) {
  const { db } = fixture()
  let state = seed
  const random = (below: number) => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state % below
  }
  const kinds = BRAIN_ENTITY_KINDS.slice(0, 3)
  const entity = db.prepare(
    "INSERT INTO entities(n,id,label,kind,description,created_at,memories) VALUES (?,?,?,?,'',1,1)",
  )
  for (let n = 1; n <= 60; n++) entity.run(n, `entity-${n}`, `Entity ${n}`, kinds[random(3)]!)
  // Listed with a stored count, but every memory naming it is superseded or gone.
  db.exec('UPDATE entities SET memories=0 WHERE n IN (7,8)')
  const memory = db.prepare(
    "INSERT INTO memories(n,id,summary,type,epistemic,scope,observed_at,recorded_at,state) VALUES (?,?,'Made up','fact','reported','/',?,1,?)",
  )
  const mention = db.prepare('INSERT OR IGNORE INTO mentions VALUES (?,?)')
  for (let n = 1; n <= 700; n++) {
    const states = ['active', 'active', 'disputed', 'superseded']
    memory.run(n, `memory-${n}`, random(40), states[random(4)]!)
    for (let i = random(3); i >= 0; i--) mention.run(n, 1 + random(58))
  }
  return { db, now: Date.now, id: () => 'x' } satisfies Context
}
it.each([1, 2, 3])('orders exactly as the definition does (Brain %s)', (seed) => {
  const ctx = brain(seed)
  for (const kind of [null, ...BRAIN_ENTITY_KINDS.slice(0, 3)]) {
    const expected = ctx.db
      .prepare(ORACLE)
      .all(kind, kind)
      .map((row) => Number(row.n))
    for (const need of [1, 5, 21, expected.length - 1, expected.length, expected.length + 5])
      for (const memories of [0, Number.MAX_SAFE_INTEGER])
        expect(recentEntities(ctx, kind, need, { total: expected.length, memories })).toEqual(
          expected.slice(0, Math.max(0, need)),
        )
  }
})
it('lists an entity whose stored count is stale after every entity with a current memory', () => {
  const ctx = brain(4)
  ctx.db.exec(
    "UPDATE memories SET state='superseded' WHERE n IN (SELECT memory FROM mentions WHERE entity=1)",
  )
  const listed = ctx.db
    .prepare(ORACLE)
    .all(null, null)
    .map((row) => Number(row.n))
  const current = new Set(
    ctx.db
      .prepare(
        "SELECT DISTINCT a.entity AS n FROM mentions a JOIN memories m ON m.n=a.memory JOIN entities e ON e.n=a.entity WHERE e.memories>0 AND m.state IN ('active','disputed')",
      )
      .all()
      .map((row) => Number(row.n)),
  )
  expect(current.has(1)).toBe(false)
  expect(listed.slice(0, current.size).every((n) => current.has(n))).toBe(true)
  expect(listed.slice(current.size)).toContain(1)
  const all = { total: listed.length, memories: Number.MAX_SAFE_INTEGER }
  expect(recentEntities(ctx, null, listed.length, all)).toEqual(listed)
})
