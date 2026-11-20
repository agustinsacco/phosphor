import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { approveRead, realService } from './__fixtures__/real-service'

it('approves and sweeps, then merges and undoes with a real store, never calling a model', async () => {
  const s = await realService()
  const status = await approveRead(s.store, s.service, s.options)
  expect(status.counts).toEqual({ memories: 4, entities: 2 })
  expect(status.tidy).toMatchObject({ automaticFolds: 1 })
  expect(status.agent.waiting).toMatchObject({ entities: 1, repeats: 6 })
  const changes = await s.service.api.tidyChanges(50)
  expect(changes.items).toMatchObject([{ kind: 'fold', who: 'automatic', undoable: true }])
  const before = s.store.waitingSuggestions(50, 0)
  const same = before.items.find((item) => item.kind === 'same_entity')!
  const survivor = same.subjects.find((subject) => subject.label === 'Rina')!
  const merged = await s.service.api.merge(
    same.subjects.find((subject) => subject.id !== survivor.id)!.id,
    survivor.id,
    status.revision,
  )
  expect(merged.counts.entities).toBe(1)
  expect(merged.operationId).toBeTruthy()
  const undone = await s.service.api.tidyUndo(merged.operationId!, merged.revision)
  expect(undone.counts.entities).toBe(2)
  expect(s.call).not.toHaveBeenCalled()
})

it('files lane flags through the agent entry and refuses a second, a sixth and a forgotten memory', async () => {
  const s = await realService()
  await approveRead(
    s.store,
    s.service,
    s.options,
    Array.from({ length: 6 }, (_, i) => `Harbor keeps Ledger policy ${i}.`),
  )
  const recall = await s.service.agent('search', { query: 'Harbor', limit: 20 })
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
  const flags = s.store.waitingSuggestions(50, 0)
  flags.items = flags.items.filter((item) => item.kind === 'flagged')
  expect(flags.items).toHaveLength(5)
  const flagged = flags.items[0]!
  if (flagged.kind === 'read') throw new Error('Expected a flag')
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
  await approveRead(s.store, s.service, s.options)
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
      .items.some(
        (item) => item.kind !== 'read' && item.subjects.some((subject) => subject.id === memory.id),
      ),
  ).toBe(true)
  expect((await s.service.api.tidyChanges(50)).items[0]?.kind).toBe('fold')
  await s.service.api.forget(memory.id)
  expect(tidyText(path)).not.toContain(sentence)
  expect(
    s.store
      .waitingSuggestions(50, 0)
      .items.every(
        (item) =>
          item.kind !== 'read' && item.subjects.every((subject) => subject.id !== memory.id),
      ),
  ).toBe(true)
  await expect(
    s.service.api.tidyUndo((await s.service.api.tidyChanges(50)).items[0]!.id, s.store.revision()),
  ).rejects.toThrow()
  await expect(s.service.api.memory(memory.id)).rejects.toThrow()
})
