import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed } from './test-support'
import { memoryCandidateCache, memoryCandidates } from './memory-candidates'

it('bounds cached entity windows and preserves candidate results across eviction', () => {
  const { db } = fixture()
  seed(db, 145)
  db.exec(
    "UPDATE entity_names SET name='Ledger ' || entity,folded='ledger ' || entity; INSERT INTO mentions SELECT n,CASE WHEN n=145 THEN 1 ELSE n+1 END FROM memories",
  )
  const ctx = { db, now: () => 1, id: () => 'unused' }
  const small = memoryCandidateCache(1)
  const normal = memoryCandidateCache(128)
  for (let n = 1; n <= 145; n++) {
    const actual = memoryCandidates(ctx, n, small)
    const expected = memoryCandidates(ctx, n, normal)
    expect(actual).toEqual(expected)
    expect(actual.items.length).toBeGreaterThan(0)
    expect(small.windows.size).toBeLessThanOrEqual(1)
    expect(normal.windows.size).toBeLessThanOrEqual(128)
  }
})
