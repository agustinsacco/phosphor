import { expect, it, vi } from 'vitest'
import { extraction, fixture, running, vector } from '../test-support'
import { seed } from '../tidy/test-support'
import { saveRead } from '../save-read'

it('captures a saved read without walking unrelated memories of a reused hub', () => {
  const { store, db } = fixture()
  seed(db, 1000)
  db.exec('INSERT OR IGNORE INTO mentions SELECT n,1 FROM memories')
  const jobId = running(store)
  const data = extraction(jobId, {
    entities: [],
    entityVectors: [],
    memoryVectors: [vector()],
    computedRevision: store.knowledgeRevision(),
  })
  data.memories = [{ ...data.memories[0]!, entities: ['rina-1'], links: [] }]
  let rowsRead = 0
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
    const saved = saveRead({ db, now: () => 10000, id: () => `capture-${++sequence}` }, data)
    expect(saved.touched.memoryIds).toHaveLength(1)
    expect(rowsRead).toBeLessThan(1000)
  } finally {
    vi.restoreAllMocks()
  }
})
let sequence = 0
