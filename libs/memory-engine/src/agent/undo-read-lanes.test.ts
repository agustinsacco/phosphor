import { describe, expect, it } from 'vitest'
import type { BrainJob } from '@phosphor/shared/brain'
import { extraction, fixture, lane } from '../test-support'

const note = { runId: null, reason: 'The lane supports these claims.' }
const decision = {
  memories: [0, 1],
  identities: {},
  groups: [],
  descriptions: [],
  confirmations: [],
}
const states: BrainJob['state'][] = [
  'waiting',
  'queued',
  'running',
  'refreshing',
  'review',
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

describe.each(['approve', 'reject'] as const)('undo of %s respects lane queue order', (kind) => {
  it.each(states)(
    'refuses atomically when a later read is %s, including tied queue times',
    (state) => {
      const { store, db } = fixture()
      const first = store.enqueue(lane(), 'queued')
      store.propose(extraction(first.id))
      const result = store.decideRead(first.id, kind === 'approve' ? decision : null, 0, note)
      const next = store.enqueue(lane({ leafId: 'leaf-2' }), 'queued')
      expect(next.fromLeafId).toBe(first.leafId)
      store.updateJob(next.id, { state })
      db.prepare('UPDATE jobs SET queued_at=? WHERE id=?').run(first.queuedAt, next.id)
      const before = databaseRows(db)
      expect(() => store.agentUndo(result.operationId, note)).toThrow(
        'Later changes touch this Brain change; it cannot be cleanly undone.',
      )
      expect(databaseRows(db)).toEqual(before)
    },
  )

  it('still undoes with only earlier reads in this lane and later reads in another', () => {
    const { store } = fixture()
    const earlier = store.enqueue(lane({ leafId: 'earlier-leaf' }), 'queued')
    store.updateJob(earlier.id, { state: 'empty' })
    const first = store.enqueue(lane(), 'queued')
    store.propose(extraction(first.id))
    const proposal = store.proposal(first.id)
    const result = store.decideRead(first.id, kind === 'approve' ? decision : null, 0, note)
    store.enqueue(lane({ sessionId: 'ledger-lane' }), 'queued')
    store.agentUndo(result.operationId, note)
    expect(store.job(first.id)?.state).toBe('review')
    expect(store.proposal(first.id)).toEqual(proposal)
    expect(store.job(earlier.id)?.state).toBe('empty')
  })
})

it('Undo run keeps an approval once a Read again has been queued', () => {
  const { store, db } = fixture()
  const run = store.createRun()
  const first = store.enqueue(lane(), 'queued')
  store.propose(extraction(first.id))
  store.decideRead(first.id, decision, 0, { ...note, runId: run.id })
  const next = store.enqueue(lane({ replaces: first.id }), 'queued')
  const before = databaseRows(db)
  expect(store.undoRun(run.id)).toEqual({ undone: 0, kept: 1 })
  expect(databaseRows(db)).toEqual(before)
  expect(store.job(next.id)?.state).toBe('queued')
})
