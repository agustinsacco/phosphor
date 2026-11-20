import { expect, it, vi } from 'vitest'
import { extraction, fixture, lane, vector } from '../test-support'
import { seed } from '../tidy/test-support'
import { decideRead } from './decide-read'

it('captures a read change without walking unrelated memories of a reused hub', () => {
  const { store, db } = fixture()
  seed(db, 1000)
  db.exec('INSERT OR IGNORE INTO mentions SELECT n,1 FROM memories')
  const job = store.enqueue(lane(), 'queued')
  const data = extraction(job.id, { entities: [], entityVectors: [], memoryVectors: [vector()] })
  data.memories = [{ ...data.memories[0]!, entities: ['rina-1'], links: [] }]
  store.propose(data)
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
    const op = decideRead(
      { db, now: () => 10000, id: () => `capture-${++sequence}` },
      job.id,
      { memories: [0], identities: {}, groups: [], descriptions: [], confirmations: [] },
      0,
      { runId: null, reason: 'The lane supports this claim.' },
    )
    expect(op.touched.memoryIds).toHaveLength(1)
    expect(rowsRead).toBeLessThan(1000)
  } finally {
    vi.restoreAllMocks()
  }
})
let sequence = 0
