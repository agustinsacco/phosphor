import { expect, it } from 'vitest'
import { extraction, fixture, running, save } from '../test-support'
import { seed } from '../tidy/test-support'

const note = { runId: null, reason: 'The source supports this decision.' }

it('undo of keep leaves a read in progress current', () => {
  const { store, db } = fixture()
  seed(db, 2)
  store.sweep({ entityIds: ['rina-1', 'rina-2'], memoryIds: [] })
  const ledger = running(store, { sessionId: 'ledger-lane', title: 'Ledger planning' })
  const revision = store.knowledgeRevision()
  const pair = store.waitingSuggestions(50, 0).items[0]!
  const operation = store.resolve(pair.suggestionId, { kind: 'keep' }, note)
  expect(store.knowledgeRevision()).toBe(revision)
  const beforeUndo = store.revision()
  store.agentUndo(operation, note)
  expect(store.revision()).toBe(beforeUndo + 1)
  expect(store.knowledgeRevision()).toBe(revision)
  const data = extraction(ledger, {
    computedRevision: revision,
    origin: { sessionId: 'ledger-lane', title: 'Ledger planning' },
  })
  expect(() => store.saveRead(data)).not.toThrow()
  expect(store.job(ledger)?.state).toBe('done')
})

it.each(['approve', 'correct', 'describe'] as const)(
  'undo of %s still invalidates waiting reads when knowledge changes',
  (kind) => {
    const { store, db } = fixture()
    seed(db, 2)
    let operation: string
    if (kind === 'approve') operation = save(store).operationId!
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
