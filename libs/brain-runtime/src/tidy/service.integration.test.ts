import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { savedRead, realService } from './__fixtures__/real-service'

it('approves and sweeps, then merges and undoes with a real store, never calling a model', async () => {
  const s = await realService()
  const status = await savedRead(s.store, s.service, s.options)
  expect(status.counts).toEqual({ memories: 4, entities: 2 })
  expect(status.tidy).toMatchObject({ automaticFolds: 1 })
  expect(status.agent.waiting).toEqual({
    groups: 0,
    unlinked: 0,
    entities: 1,
    repeats: 6,
    conflicts: 0,
    flags: 0,
  })
  expect(status.agent.run).toBeNull()
  const changes = await s.service.api.tidyChanges(50)
  expect(changes.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'fold', who: 'automatic', undoable: true }),
      expect.objectContaining({ kind: 'read' }),
    ]),
  )
  const before = await s.service.agent('waiting', { limit: 50 })
  const same = before.items.find((item) => item.kind === 'same_entity')
  if (!same) throw new Error('Expected a waiting identity pair')
  const survivor = same.subjects.find((subject) => subject.label === 'Rina')!
  const merged = await s.service.agent('resolve', {
    suggestionId: same.suggestionId,
    action: { kind: 'merge', survivorId: survivor.id },
    reason: 'The Ledger records describe the same person.',
  })
  expect((await s.service.api.status()).counts.entities).toBe(1)
  expect(merged).toMatchObject({ status: 'done', operationId: expect.any(String) })
  const undone = await s.service.api.tidyUndo(merged.operationId!, s.store.revision())
  expect(undone.counts.entities).toBe(2)
  expect(s.call).not.toHaveBeenCalled()
})

it('files lane flags through the agent entry and refuses a second, a sixth and a forgotten memory', async () => {
  const s = await realService()
  await savedRead(
    s.store,
    s.service,
    s.options,
    Array.from({ length: 6 }, (_, i) => `Harbor keeps Ledger policy ${i}.`),
  )
  const recall = await s.service.agent('search', { query: 'Harbor', limit: 20 })
  if (recall.mode !== 'search') throw new Error('Expected search hits')
  expect(recall.hits).toHaveLength(6)
  const ids = recall.hits.map((hit) => hit.memory.id)
  const flag = (memoryId: string) =>
    s.service.agent('flag', {
      memoryId,
      sessionId: 'kestrel-lane',
      title: 'Kestrel review',
      problem: 'wrong',
      reason: 'The lane verified a different Ledger policy.',
    })
  expect((await flag(ids[0]!)).status).toBe('filed')
  expect((await flag(ids[0]!)).status).toBe('already_flagged')
  for (const id of ids.slice(1, 5)) expect((await flag(id)).status).toBe('filed')
  expect((await flag(ids[5]!)).status).toBe('limit')
  const waiting = await s.service.agent('waiting', { limit: 50 })
  const flags = waiting.items.filter((item) => item.kind === 'flagged')
  expect(flags).toHaveLength(5)
  const flagged = flags[0]!
  expect(
    (await s.service.agent('suggestion', { suggestionId: flagged.suggestionId }))?.suggestion.flag,
  ).toMatchObject({ sessionId: 'kestrel-lane', title: 'Kestrel review' })
  await s.service.api.forget(ids[0]!)
  expect((await flag(ids[0]!)).status).toBe('unavailable')
})

function tidyText(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tidy_%'")
      .all()
    return JSON.stringify(
      tables.map(({ name }) => db.prepare(`SELECT * FROM ${String(name)}`).all()),
    )
  } finally {
    db.close()
  }
}

it('Forget removes a suggested memory and its before-images from every Tidy table', async () => {
  const s = await realService()
  await savedRead(s.store, s.service, s.options)
  const path = join(s.directory, 'brain.sqlite')
  const sentence = 'Rina leads Ledger.'
  const memory = (await s.service.api.find(sentence, 20)).memories.find(
    (m) => m.summary === sentence,
  )!
  expect(memory).toBeDefined()
  expect(tidyText(path)).toContain(sentence)
  expect(
    s.store
      .waitingSuggestions(50, 0)
      .items.some((item) => item.subjects.some((subject) => subject.id === memory.id)),
  ).toBe(true)
  expect((await s.service.api.tidyChanges(50)).items[0]?.kind).toBe('fold')
  await s.service.api.forget(memory.id)
  expect(tidyText(path)).not.toContain(sentence)
  expect(
    (await s.service.agent('waiting', { limit: 50 })).items.every((item) =>
      item.subjects.every((subject) => subject.id !== memory.id),
    ),
  ).toBe(true)
  await expect(
    s.service.api.tidyUndo((await s.service.api.tidyChanges(50)).items[0]!.id, s.store.revision()),
  ).rejects.toThrow()
  await expect(s.service.api.memory(memory.id)).rejects.toThrow()
})
