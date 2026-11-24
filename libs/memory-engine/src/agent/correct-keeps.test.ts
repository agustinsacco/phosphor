import { expect, it } from 'vitest'
import { extraction, fixture, save, vector } from '../test-support'

const note = { runId: null, reason: 'The ticket spells the service differently.' }
const fix = { source: 'Linear KES-12', quote: 'Harbor archive, not Harbour archive.' }

it('keeps the importance and the validity period of the memory it corrects', () => {
  const { store, db } = fixture()
  const claim = extraction('unused').memories[1]!
  save(store, {
    memories: [{ ...claim, validFrom: 5, hold: 'temporary', importance: 2 }],
    memoryVectors: [vector()],
  })
  const old = db
    .prepare('SELECT id,importance,valid_from AS validFrom,valid_to AS validTo FROM memories')
    .get() as { id: string; importance: number; validFrom: number; validTo: number }
  expect(old).toMatchObject({ importance: 2, validFrom: 5 })
  expect(old.validTo).toBeGreaterThan(old.validFrom)
  store.correct(
    { memoryId: old.id, summary: 'Tom Lee maintains the Harbor archive.', ...fix },
    null,
    note,
  )
  expect(
    db
      .prepare(
        "SELECT importance,valid_from AS validFrom,valid_to AS validTo FROM memories WHERE state='active'",
      )
      .get(),
  ).toEqual({ importance: 2, validFrom: old.validFrom, validTo: old.validTo })
})
