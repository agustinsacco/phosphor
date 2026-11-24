import { expect, it } from 'vitest'
import { extraction, fixture, lane } from '../test-support'
import { seed } from '../tidy/test-support'

const note = { runId: null, reason: 'The source supports this decision.' }
const decision = {
  memories: [0, 1],
  identities: {},
  groups: [],
  descriptions: [],
  confirmations: [],
}

it.each(['reject', 'keep'] as const)('undo of %s leaves other waiting reads current', (kind) => {
  const { store, db } = fixture()
  seed(db, 2)
  store.sweep({ entityIds: ['rina-1', 'rina-2'], memoryIds: [] })
  const harbor = store.enqueue(lane(), 'queued')
  const ledger = store.enqueue(
    lane({ sessionId: 'ledger-lane', title: 'Ledger planning' }),
    'queued',
  )
  for (const job of [harbor, ledger])
    store.propose(
      extraction(job.id, {
        computedRevision: store.knowledgeRevision(),
        origin: { sessionId: job.sessionId, title: job.title },
      }),
    )
  const revision = store.proposal(ledger.id).revision
  const pair = store.waitingSuggestions(50, 0).items[0]!
  if (pair.kind === 'read') throw new Error('Expected an entity pair')
  const operation =
    kind === 'reject'
      ? store.decideRead(harbor.id, null, revision, note).operationId
      : store.resolve(pair.suggestionId, { kind: 'keep' }, note)
  expect(store.knowledgeRevision()).toBe(revision)
  const beforeUndo = store.revision()
  store.agentUndo(operation, note)
  expect(store.revision()).toBe(beforeUndo + 1)
  expect(store.knowledgeRevision()).toBe(revision)
  expect(() => store.decideRead(ledger.id, decision, revision, note)).not.toThrow()
  expect(store.job(ledger.id)?.state).toBe('done')
  expect(store.job(harbor.id)?.state).toBe('review')
})

it.each(['approve', 'correct', 'describe'] as const)(
  'undo of %s still invalidates waiting reads when knowledge changes',
  (kind) => {
    const { store, db } = fixture()
    seed(db, 2)
    const job = store.enqueue(lane(), 'queued')
    store.propose(extraction(job.id))
    let operation: string
    if (kind === 'approve') operation = store.decideRead(job.id, decision, 0, note).operationId
    else if (kind === 'correct')
      operation = store.correct(
        {
          memoryId: 'memory-1',
          summary: 'Rina leads the Ledger API team.',
          source: 'Linear KES-12',
          quote: 'Rina leads the API team.',
        },
        null,
        note,
      ).operationId
    else
      operation = store.agentEdit(
        { kind: 'describe', entityId: 'rina-1', description: 'Ledger API lead' },
        note,
      )
    const revision = store.knowledgeRevision()
    const beforeUndo = store.revision()
    store.agentUndo(operation, note)
    expect(store.knowledgeRevision()).toBe(revision + 1)
    expect(store.revision()).toBeGreaterThan(beforeUndo)
  },
)
