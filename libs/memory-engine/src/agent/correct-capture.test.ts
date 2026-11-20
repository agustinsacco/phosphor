import { expect, it, vi } from 'vitest'
import { fixture } from '../test-support'
import { hub } from '../tidy/test-support'
import { correct } from './correct'

it("captures a correction without reading the mentioned hub's unrelated memories or relations", () => {
  const { store, db } = fixture()
  hub(db, 20000)
  db.exec(`INSERT INTO relations(memory,subject,predicate,object,live,observed_at)
    SELECT n,1,'works_on',2,1,n FROM memories WHERE n>2`)
  let rowsRead = 0,
    sequence = 0
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql),
      all = statement.all.bind(statement)
    vi.spyOn(statement, 'all').mockImplementation((...args) => {
      const rows = all(...args)
      rowsRead += rows.length
      return rows
    })
    return statement
  })
  try {
    correct(
      { db, now: () => 30000, id: () => `correct-${++sequence}` },
      {
        memoryId: 'memory-1',
        summary: 'Rina leads the Ledger API team.',
        source: 'Linear KES-12',
        quote: 'Rina leads the API team.',
      },
      null,
      { runId: null, reason: 'The current source corrects this responsibility.' },
    )
    expect(rowsRead).toBeLessThan(1000)
  } finally {
    vi.restoreAllMocks()
  }
  expect(store.memory('memory-1').memory.state).toBe('superseded')
  const current = db.prepare("SELECT id FROM memories WHERE id LIKE 'correct-%'").get() as {
    id: string
  }
  expect(store.memory(current.id).memory.entityIds).toEqual(['rina-1'])
  expect(db.prepare('SELECT memories FROM entities WHERE n=1').get()).toEqual({ memories: 20000 })
  expect(db.prepare('SELECT COUNT(*) AS n FROM relations WHERE live=1').get()).toEqual({ n: 20000 })
})
