import { describe, expect, it } from 'vitest'
import type { BrainJob } from '@phosphor/shared/brain'
import { fixture, lane, save } from '../test-support'

const note = { runId: null, reason: 'The lane supports these claims.' }
const states: BrainJob['state'][] = [
  'waiting',
  'queued',
  'running',
  'done',
  'empty',
  'rejected',
  'failed',
]
function databaseRows(db: ReturnType<typeof fixture>['db']) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  return Object.fromEntries(
    tables.map(({ name }) => [String(name), db.prepare(`SELECT * FROM "${name}"`).all()]),
  )
}

describe('undo of a saved read respects lane queue order', () => {
  it.each(states)(
    'refuses atomically when a later read is %s, including tied queue times',
    (state) => {
      const { store, db } = fixture()
      const saved = save(store)
      const first = store.job(saved.jobId)!
      const next = store.enqueue(lane({ leafId: 'leaf-2' }), 'queued')
      expect(next.fromLeafId).toBe(first.leafId)
      store.updateJob(next.id, { state })
      db.prepare('UPDATE jobs SET queued_at=? WHERE id=?').run(first.queuedAt, next.id)
      const before = databaseRows(db)
      expect(() => store.agentUndo(saved.operationId!, note)).toThrow(
        'Later changes touch this Brain change; it cannot be cleanly undone.',
      )
      expect(databaseRows(db)).toEqual(before)
    },
  )

  it('still undoes with only earlier reads in this lane and later reads in another', () => {
    const { store } = fixture()
    const earlier = store.enqueue(lane({ leafId: 'earlier-leaf' }), 'queued')
    store.updateJob(earlier.id, { state: 'empty' })
    const saved = save(store)
    store.enqueue(lane({ sessionId: 'ledger-lane' }), 'queued')
    store.agentUndo(saved.operationId!, note)
    expect(store.job(earlier.id)?.state).toBe('empty')
  })
})
