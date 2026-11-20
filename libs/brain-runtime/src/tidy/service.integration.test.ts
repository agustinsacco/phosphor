import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { approveRead, realService } from './__fixtures__/real-service'

it('approves and sweeps, then merges and undoes with a real store, never calling a model', async () => {
  const s = await realService()
  const status = await approveRead(s.store, s.service, s.options)
  expect(status.counts).toEqual({ memories: 4, entities: 2 })
  expect(status.tidy).toMatchObject({ open: 7, automaticFolds: 1, running: false })
  const changes = await s.service.api.tidyChanges(50)
  expect(changes.items).toMatchObject([{ kind: 'fold', who: 'automatic', undoable: true }])
  const before = await s.service.api.tidy(null, null, 50)
  expect(before.counts).toEqual({ same_entity: 1, same_memory: 6, conflict: 0, flagged: 0 })
  expect(before.run).toBeNull()
  const same = before.items.find((item) => item.kind === 'same_entity')!
  const survivor = same.subjects.find((subject) => subject.label === 'Rina')!
  const merged = await s.service.api.tidyApply(
    same.id,
    { kind: 'merge', survivorId: survivor.id },
    before.revision,
  )
  expect(merged.counts.entities).toBe(1)
  expect(merged.operationId).toBeTruthy()
  const undone = await s.service.api.tidyUndo(merged.operationId!, merged.revision)
  expect(undone.counts.entities).toBe(2)
  expect(s.call).not.toHaveBeenCalled()
})

it('refuses a stale dispute with a plain sentence, then journals it at the current revision', async () => {
  const s = await realService()
  await approveRead(s.store, s.service, s.options)
  const page = await s.service.api.tidy('same_memory', null, 50)
  const details = await Promise.all(page.items.map((i) => s.service.api.tidySuggestion(i.id)))
  const pair = page.items[details.findIndex((d) => d?.allowed.includes('dispute'))]!
  const before = await s.service.api.tidyChanges(50)
  await s.service.api.tidyDismiss(page.items.find((item) => item.id !== pair.id)!.id, page.revision)
  await expect(
    s.service.api.tidyApply(pair.id, { kind: 'dispute' }, page.revision),
  ).rejects.toThrow('Brain changed; refresh Tidy and try again.')
  expect(await s.service.api.tidyChanges(50)).toMatchObject({ items: before.items })
  const fresh = (await s.service.api.status()).revision
  const disputed = await s.service.api.tidyApply(pair.id, { kind: 'dispute' }, fresh)
  expect(disputed.operationId).toBeTruthy()
  expect((await s.service.api.tidyChanges(50)).items[0]).toMatchObject({
    id: disputed.operationId,
    kind: 'dispute',
  })
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
  const flags = await s.service.api.tidy('flagged', null, 20)
  expect(flags.items).toHaveLength(5)
  expect(flags.items[0]?.flag).toMatchObject({ sessionId: 'kestrel-lane', title: 'Kestrel review' })
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
    (await s.service.api.tidy(null, null, 50)).items.some((item) =>
      item.subjects.some((subject) => subject.id === memory.id),
    ),
  ).toBe(true)
  expect((await s.service.api.tidyChanges(50)).items[0]?.kind).toBe('fold')
  await s.service.api.forget(memory.id)
  expect(tidyText(path)).not.toContain(sentence)
  expect(
    (await s.service.api.tidy(null, null, 50)).items.every((item) =>
      item.subjects.every((subject) => subject.id !== memory.id),
    ),
  ).toBe(true)
  await expect(
    s.service.api.tidyUndo((await s.service.api.tidyChanges(50)).items[0]!.id, s.store.revision()),
  ).rejects.toThrow()
  await expect(s.service.api.memory(memory.id)).rejects.toThrow()
})
