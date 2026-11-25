import { expect, it } from 'vitest'
import { saveAndListMemories, fixture } from './test-support'

it('offers no memory as stating the same link once that link has ended (F23)', () => {
  const { store, db } = fixture()
  saveAndListMemories(store)
  const nodes = store.overview(300).nodes
  const rina = nodes.find((item) => item.label === 'Rina Okafor')!.id
  const harbor = nodes.find((item) => item.label === 'Harbor')!.id
  const probe = {
    entityIds: [],
    links: [{ subjectId: rina, predicate: 'owns' as const, objectId: harbor }],
  }
  const linked = () =>
    store.memoryMatches([probe], 5)[0]!.filter((match) => match.channel === 'link')
  expect(linked()).toHaveLength(1)
  db.prepare("UPDATE relations SET valid_to=1 WHERE predicate='owns'").run()
  expect(linked()).toEqual([])
})
