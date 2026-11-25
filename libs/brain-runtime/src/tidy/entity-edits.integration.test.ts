import { expect, it } from 'vitest'
import { savedRead, realService } from './__fixtures__/real-service'

it('describes, removes a name and splits through the API, each undoable from its operation', async () => {
  const s = await realService()
  const status = await savedRead(s.store, s.service, s.options)
  const entity = s.store.overview(300).nodes.find((node) => node.memories > 1)!
  await expect(
    s.service.api.describe(entity.id, 'Harbor billing lead', status.revision + 1),
  ).rejects.toThrow('Brain changed')
  const described = await s.service.api.describe(entity.id, 'Harbor billing lead', status.revision)
  expect(described.operationId).toBeTruthy()
  expect(described.revision).toBe(status.revision + 1)
  expect((await s.service.api.entity(entity.id)).entity.description).toBe('Harbor billing lead')

  const memories = (await s.service.api.entityMemories(entity.id, {}, null)).memories
  const split = await s.service.api.split(
    entity.id,
    [memories[0]!.id],
    { label: 'Ledger contractor', kind: 'person' },
    described.revision,
  )
  expect(split.counts.entities).toBe(status.counts.entities + 1)
  const found = await s.service.api.find('Ledger contractor', 5)
  expect(found.entities.map((e) => e.label)).toContain('Ledger contractor')
  const changes = await s.service.api.tidyChanges(10)
  // The read that saved the fixture's knowledge is a change too, the oldest one.
  expect(changes.items.map((item) => item.kind)).toEqual(['split', 'describe', 'fold', 'read'])
  const undone = await s.service.api.tidyUndo(split.operationId!, split.revision)
  expect(undone.counts.entities).toBe(status.counts.entities)
  await expect(s.service.api.removeName(entity.id, entity.label, undone.revision)).rejects.toThrow(
    'main name',
  )
})
