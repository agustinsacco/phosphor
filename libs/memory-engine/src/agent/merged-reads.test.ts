import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed } from '../tidy/test-support'

it('reads merged-away entity ids as their survivor, including chains; writes stay strict', () => {
  const { store, db } = fixture()
  seed(db, 3)
  store.merge('rina-1', 'rina-2', store.revision())
  store.merge('rina-2', 'rina-3', store.revision())
  expect(store.entity('rina-1')).toEqual(store.entity('rina-3'))
  expect(store.neighbourhood('rina-1', 1, 50)).toEqual(store.neighbourhood('rina-3', 1, 50))
  expect(store.connections('rina-1', 'owns', 'out', null)).toEqual(
    store.connections('rina-3', 'owns', 'out', null),
  )
  expect(store.entityMemories('rina-1', {}, null)).toEqual(store.entityMemories('rina-3', {}, null))
  expect(store.path('rina-1', 'rina-3')).toEqual(store.path('rina-3', 'rina-3'))
  expect(() => store.merge('rina-1', 'rina-3', store.revision())).toThrow()
})
