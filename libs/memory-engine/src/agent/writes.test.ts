import { describe, expect, it } from 'vitest'
import { BRAIN_ERASE_LIMIT, BRAIN_ERASE_LIMIT_REFUSAL } from '@phosphor/shared/brain-agent'
import { fixture, vector } from '../test-support'
import { dump, seed } from '../tidy/test-support'

const note = { runId: null, reason: 'These refer to separate responsibilities.' }

describe('Brain Agent writes and journal', () => {
  it('journals keep and undo reopens the pair; unchecked pairs have actions', () => {
    const { store, db } = fixture()
    seed(db, 2)
    store.sweep({ entityIds: ['rina-1', 'rina-2'], memoryIds: [] })
    const pair = store.waitingSuggestions(50, 40).items[0]!
    const op = store.resolve(pair.suggestionId, { kind: 'keep' }, note)
    expect(store.tidyChanges(50).items[0]).toMatchObject({
      id: op,
      kind: 'keep',
      who: 'agent',
      undoable: true,
    })
    expect(store.waitingCounts().entities).toBe(0)
    store.agentUndo(op, note)
    expect(store.waitingCounts().entities).toBe(1)
    db.prepare(
      "UPDATE tidy_suggestions SET kind='unchecked',subject_type='memory',first_id='memory-1',second_id='memory-2'",
    ).run()
    expect(store.agentSuggestion(pair.suggestionId)).toMatchObject({
      suggestion: { kind: 'same_memory' },
      allowed: expect.arrayContaining(['fold', 'dispute', 'replace', 'keep']),
    })
    expect(store.waitingSuggestions(50, 1).items[0]).toMatchObject({ kind: 'possible_repeat' })
    expect(() => store.resolve(pair.suggestionId, { kind: 'forget' }, note)).toThrow(
      'Use brain_erase',
    )
  })
  it('corrects a memory with a sourced quote, preserving mentions, and undoes exactly', () => {
    const { store, db } = fixture()
    seed(db, 2)
    const before = dump(db)
    const op = store.correct(
      {
        memoryId: 'memory-1',
        summary: 'Rina leads the Ledger API team.',
        source: 'Linear KES-12',
        quote: 'Rina leads the API team.',
      },
      vector(),
      note,
    ).operationId
    expect(store.memory('memory-1').memory.state).toBe('superseded')
    const fresh = db
      .prepare("SELECT id FROM memories WHERE id NOT IN ('memory-1','memory-2')")
      .get() as { id: string }
    expect(store.memory(fresh.id)).toMatchObject({
      memory: { summary: 'Rina leads the Ledger API team.', entityIds: ['rina-1'] },
      quotes: [expect.objectContaining({ label: 'Brain Agent, from Linear KES-12' })],
    })
    expect(() =>
      store.correct(
        { memoryId: 'memory-1', summary: 'Wrong', source: 'Linear', quote: 'Wrong' },
        null,
        note,
      ),
    ).toThrow()
    store.agentUndo(op, note)
    expect(dump(db)).toEqual(before)
  })
  it('erases finally, retains only safe journal metadata, and enforces the rolling cap', () => {
    const { store, db } = fixture()
    seed(db, BRAIN_ERASE_LIMIT + 1)
    for (let i = 1; i <= BRAIN_ERASE_LIMIT; i++) store.erase(`memory-${i}`, note)
    const before = dump(db)
    expect(() => store.erase(`memory-${BRAIN_ERASE_LIMIT + 1}`, note)).toThrow(
      BRAIN_ERASE_LIMIT_REFUSAL,
    )
    expect(dump(db)).toEqual(before)
    const op = store.tidyChanges(50).items[0]!
    expect(op).toMatchObject({
      kind: 'erase',
      summary: 'Erased a memory',
      undoable: false,
      who: 'agent',
    })
    expect(() => store.agentUndo(op.id, note)).toThrow("Erasing can't be undone.")
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_config' AND name NOT LIKE '%_data' AND name NOT LIKE '%_idx' AND name NOT LIKE '%_docsize'",
      )
      .all() as { name: string }[]
    for (const { name } of tables)
      expect(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).not.toContain(
        'Rina leads Ledger area 1.',
      )
    db.prepare("UPDATE tidy_operations SET created_at=-4000000 WHERE kind='erase'").run()
    expect(() => store.erase(`memory-${BRAIN_ERASE_LIMIT + 1}`, note)).not.toThrow()
  })
  it.each(['', 'a\nb', 'x'.repeat(301)])('rejects invalid reason %j atomically', (reason) => {
    const { store, db } = fixture()
    seed(db, 1)
    const before = dump(db)
    expect(() => store.erase('memory-1', { ...note, reason })).toThrow()
    expect(dump(db)).toEqual(before)
  })
  it('records a reason on entity edits and on undo', () => {
    const { store, db } = fixture()
    seed(db, 2)
    const op = store.agentEdit(
      { kind: 'describe', entityId: 'rina-1', description: 'Ledger lead' },
      note,
    )
    store.agentUndo(op, { ...note, reason: 'The earlier description was clearer.' })
    expect(
      db.prepare('SELECT role,reason FROM agent_notes WHERE operation_id=? ORDER BY role').all(op),
    ).toEqual([
      { role: 'made', reason: note.reason },
      { role: 'undid', reason: 'The earlier description was clearer.' },
    ])
  })
})

it('refuses erasure reasons quoting the summary, case-insensitively with collapsed whitespace', () => {
  const { store, db } = fixture()
  seed(db, 1)
  const before = dump(db)
  expect(() =>
    store.erase('memory-1', { ...note, reason: 'Remove: RINA  LEADS Ledger area 1.' }),
  ).toThrow('Give a reason without quoting the memory; nothing changed.')
  expect(dump(db)).toEqual(before)
  db.prepare('UPDATE memories SET summary=? WHERE id=?').run(
    'Rina leads the Ledger API team and maintains the release archive every month.',
    'memory-1',
  )
  expect(() =>
    store.erase('memory-1', {
      ...note,
      reason: 'Because: RINA LEADS THE LEDGER API TEAM AND MAINTAINS the release archive.',
    }),
  ).toThrow('Give a reason without quoting the memory; nothing changed.')
})
