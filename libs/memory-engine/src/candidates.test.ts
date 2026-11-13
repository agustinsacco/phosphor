import { expect, it, vi } from 'vitest'
import { wordRows, entityMatches } from './candidates'
import { createEntity } from './entities'
import { fixture } from './test-support'

function commonWords() {
  const { db } = fixture()
  const ctx = { db, now: () => 1, id: () => 'unused' }
  db.exec('BEGIN')
  const insert = db.prepare('INSERT INTO memory_words(rowid,summary) VALUES (?,?)')
  for (let n = 1; n <= 6000; n++) insert.run(n, `Ledger synthetic fact ${n}`)
  db.prepare("UPDATE meta SET value='6000' WHERE key='memories'").run()
  db.exec('COMMIT')
  return ctx
}

it('uses newest rowids, never bm25, when every lexical term is common', () => {
  const ctx = commonWords()
  const prepare = vi.spyOn(ctx.db, 'prepare')
  expect(wordRows(ctx, 'memory_words', 'synthetic', 3).map((row) => row.rowid)).toEqual([
    6000, 5999, 5998,
  ])
  expect(prepare.mock.calls.some(([sql]) => sql.includes('bm25'))).toBe(false)
})

it('keeps a rare AND match, and never falls back to OR over common terms', () => {
  const ctx = commonWords()
  expect(wordRows(ctx, 'memory_words', 'Ledger 27', 5).map((row) => row.rowid)).toEqual([27])
  expect(wordRows(ctx, 'memory_words', 'Ledger kestrel', 5)).toEqual([])
})

it('skips broad trigrams but keeps rare partial names and word fallback on typos', () => {
  const { db } = fixture()
  let id = 0
  const ctx = { db, now: () => 1, id: () => `entity-${++id}` }
  db.exec('BEGIN')
  for (let n = 1; n <= 5001; n++)
    createEntity(ctx, {
      label: `Ledger ${n}`,
      kind: 'project',
      aliases: [],
      keys: [],
      description: '',
    })
  const harbor = createEntity(ctx, {
    label: 'Harbor export',
    kind: 'project',
    aliases: [],
    keys: [],
    description: '',
  })
  db.exec('COMMIT')
  const matches = (label: string) => entityMatches(ctx, [{ label, aliases: [], keys: [] }], 5)[0]!
  expect(matches('ledger').some((item) => item.channel === 'trigram')).toBe(false)
  expect(matches('arbor exp')).toContainEqual({
    entityId: harbor,
    channel: 'trigram',
    score: expect.any(Number),
  })
  expect(matches('Harbor exprot').some((item) => item.entityId === harbor)).toBe(true)
})
