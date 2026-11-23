import { expect, it } from 'vitest'
import { laneIdInRef, laneIdOf, laneRefFor } from './binding'
import { laneIdOfRef } from './handlers/lane-target'

const ID = '11111111-1111-4111-8111-111111111111'

it('resolves a lane ref only for this machine, and passes a bare id through', () => {
  expect(laneIdOf(`host:me/lane:${ID}`, ['me', 'alias'])).toBe(ID)
  expect(laneIdOf(`host:alias/lane:${ID}`, ['me', 'alias'])).toBe(ID)
  expect(laneIdOf(`host:other/lane:${ID}`, ['me'])).toBeNull()
  expect(laneIdOf(`host:local/lane:${ID}`, [])).toBe(ID)
  expect(laneIdOf(`host:local/lane:${ID}`, ['me'])).toBeNull()
  expect(laneIdOf(ID, ['me'])).toBe(ID)
})

it('reads the lane id of a resolved ref, a bare id as itself', () => {
  expect(laneIdInRef(`host:me/lane:${ID}`)).toBe(ID)
  expect(laneIdInRef(ID)).toBe(ID)
})

it('reads only a resolved ref when the op needs a lane on this machine', () => {
  expect(laneIdOfRef(`host:me/lane:${ID}`)).toBe(ID)
  expect(laneIdOfRef(ID)).toBeUndefined()
})

it('writes refs under the enrolled id, else local', () => {
  expect(laneRefFor(['me', 'alias'], ID)).toBe(`host:me/lane:${ID}`)
  expect(laneRefFor([], ID)).toBe(`host:local/lane:${ID}`)
})
