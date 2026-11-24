import { expect, it } from 'vitest'
import { approve, fixture } from '../test-support'

const note = { runId: null, reason: 'The ticket names a different owner.' }
interface LinkRow {
  subject: string
  predicate: string
  object: string
  label: string
  validTo: number | null
  statedBy: string
  live: number
  support: number
}
function links(db: ReturnType<typeof fixture>['db'], memoryId: string): LinkRow[] {
  return db
    .prepare(
      `SELECT s.label AS subject,r.predicate,o.label AS object,r.label,r.valid_to AS validTo,
      r.stated_by AS statedBy,r.live,(SELECT COUNT(*) FROM relation_support WHERE relation=r.n) AS support
      FROM relations r JOIN memories m ON m.n=r.memory JOIN entities s ON s.n=r.subject
      JOIN entities o ON o.n=r.object WHERE m.id=? ORDER BY r.predicate,s.label`,
    )
    .all(memoryId) as unknown as LinkRow[]
}
function ownerMemory(db: ReturnType<typeof fixture>['db']): string {
  return String(
    db
      .prepare(
        "SELECT m.id FROM memories m JOIN relations r ON r.memory=m.n WHERE r.predicate='owns'",
      )
      .get()!.id,
  )
}
function entityId(db: ReturnType<typeof fixture>['db'], label: string): string {
  return String(db.prepare('SELECT id FROM entities WHERE label=?').get(label)!.id)
}
function corrected(db: ReturnType<typeof fixture>['db'], oldId: string) {
  return db
    .prepare(
      `SELECT m.id,m.recorded_at AS recordedAt FROM memory_links l JOIN memories m ON m.n=l.source
      JOIN memories o ON o.n=l.target WHERE o.id=? AND l.kind='supersedes'`,
    )
    .get(oldId) as { id: string; recordedAt: number }
}

it('a correction carries the old memory links to the corrected memory, and undo restores them', () => {
  const { store, db } = fixture()
  approve(store)
  const old = ownerMemory(db)
  const before = links(db, old)
  const result = store.correct(
    {
      memoryId: old,
      summary: 'Rina Okafor owns the Harbor billing service and its archive.',
      source: 'Linear KES-12',
      quote: 'Rina owns Harbor and the archive.',
    },
    null,
    note,
  )
  const next = corrected(db, old)
  expect(links(db, next.id)).toEqual(before)
  expect(result.carried.map((link) => link.predicate)).toEqual(['owns'])
  expect(result.ended).toEqual([])
  expect(
    db
      .prepare('SELECT COUNT(*) AS n FROM mentions a JOIN memories m ON m.n=a.memory WHERE m.id=?')
      .get(next.id),
  ).toEqual({ n: 2 })
  store.agentUndo(result.operationId, note)
  expect(links(db, old)).toEqual(before)
  expect(db.prepare('SELECT 1 FROM memories WHERE id=?').get(next.id)).toBeUndefined()
})

it('a corrected link naming a new owner ends the old link instead of carrying it as current', () => {
  const { store, db } = fixture()
  approve(store)
  const old = ownerMemory(db)
  const result = store.correct(
    {
      memoryId: old,
      summary: 'Tom Lee owns the Harbor billing service.',
      source: 'Linear KES-12',
      quote: 'Tom owns Harbor now.',
      links: [
        {
          subjectId: entityId(db, 'Tom Lee'),
          predicate: 'owns',
          objectId: entityId(db, 'Harbor'),
          label: 'owns',
        },
      ],
    },
    null,
    note,
  )
  const next = corrected(db, old)
  expect(links(db, next.id)).toEqual([
    {
      subject: 'Rina Okafor',
      predicate: 'owns',
      object: 'Harbor',
      label: 'owns',
      validTo: next.recordedAt,
      statedBy: 'reader',
      live: 1,
      support: 1,
    },
    {
      subject: 'Tom Lee',
      predicate: 'owns',
      object: 'Harbor',
      label: 'owns',
      validTo: null,
      statedBy: 'agent',
      live: 1,
      support: 1,
    },
  ])
  expect(result.ended.map((link) => link.subjectId)).toEqual([entityId(db, 'Rina Okafor')])
})

it('a link the correction ends is kept as history with an end date', () => {
  const { store, db } = fixture()
  approve(store)
  const old = ownerMemory(db)
  const relation = String(
    db
      .prepare(
        "SELECT r.n FROM relations r JOIN memories m ON m.n=r.memory WHERE m.id=? AND r.predicate='owns'",
      )
      .get(old)!.n,
  )
  const result = store.correct(
    {
      memoryId: old,
      summary: 'Rina Okafor owned the Harbor billing service until this week.',
      source: 'Slack #ledger',
      quote: 'Rina handed Harbor over.',
      ends: [relation],
    },
    null,
    note,
  )
  const next = corrected(db, old)
  expect(links(db, next.id).map((link) => link.validTo)).toEqual([next.recordedAt])
  expect(result.ended.map((link) => link.predicate)).toEqual(['owns'])
})
