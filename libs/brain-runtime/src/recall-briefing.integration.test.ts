import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { realService } from './tidy/__fixtures__/real-service'

async function setup() {
  const s = await realService()
  const db = new DatabaseSync(join(s.directory, 'brain.sqlite'))
  try {
    db.exec(`INSERT INTO entities(n,id,label,kind,created_at) VALUES(1,'h','Harbor','team',1);
      INSERT INTO entity_names(entity,name,folded) VALUES(1,'Harbor','harbor'),(1,'Ledger','ledger');`)
    for (let n = 2; n <= 12; n++) {
      db.prepare("INSERT INTO entities(n,id,label,kind,created_at) VALUES(?,?,?,'person',1)").run(
        n,
        `p${n}`,
        'Tom Lee',
      )
      db.prepare(
        "INSERT INTO memories(n,id,summary,type,epistemic,scope,recorded_at,observed_at,state) VALUES(?,?,?,'fact','reported',?,1,1,'active')",
      ).run(n, `m${n}`, `Harbor fact ${n}.`, n === 2 ? '/Harbor' : '/Ledger')
      db.prepare('INSERT INTO mentions VALUES(?,1)').run(n)
      db.prepare(
        "INSERT INTO relations(memory,subject,predicate,object,live,observed_at) VALUES(?,?,'member_of',1,1,1)",
      ).run(n, n)
    }
  } finally {
    db.close()
  }
  return s.service.forLane({ cwd: '/Harbor', sessionId: 'harbor', title: 'Harbor' })
}
it('prints how many members the expansion page left out', async () => {
  const lane = await setup()
  expect(await lane.search({ from: 'Harbor' })).toMatchObject({
    text: expect.stringContaining('+3 more members'),
  })
})
it('boosts the lane project before applying the expansion limit', async () => {
  const lane = await setup()
  expect(await lane.search({ from: 'Harbor', limit: 1 })).toMatchObject({
    text: expect.stringContaining('[1] Harbor fact 2.'),
  })
})
it('explains a route whose names resolve to one record', async () => {
  const lane = await setup()
  const result = await lane.search({ from: 'Harbor', to: 'Ledger' })
  expect(result).toMatchObject({
    text: expect.stringMatching(/same record/i),
    data: { status: 'no_match' },
  })
})
