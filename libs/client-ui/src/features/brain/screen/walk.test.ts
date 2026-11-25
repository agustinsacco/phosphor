import { expect, it } from 'vitest'
import type { BrainLink } from '@shared/brain'
import { moveWalk, NO_WALK, walkStep, walkTo } from './walk'

const mara = { id: 'mara', label: 'Mara Voss' }
const tom = { id: 'tom', label: 'Tom Lee' }
const rina = { id: 'rina', label: 'Rina Okafor' }
const link = (subjectId: string, objectId: string, label: string): BrainLink => ({
  id: `${subjectId}-${objectId}`,
  subjectId,
  objectId,
  predicate: 'works_with',
  memoryId: 'memory',
  label,
  validFrom: null,
  validTo: null,
  statedBy: 'reader',
})

it('words each step subject to object, whichever way the walk went', () => {
  expect(walkStep(mara, tom, link('tom', 'mara', 'reports to')).sentence).toBe(
    'Tom Lee reports to Mara Voss',
  )
  expect(walkStep(tom, mara, link('tom', 'mara', 'reports to')).sentence).toBe(
    'Tom Lee reports to Mara Voss',
  )
  expect(walkStep(mara, tom, null)).toEqual({
    id: 'tom',
    label: 'Tom Lee',
    link: null,
    sentence: null,
  })
})

it('starts from where the map was, drops forward steps on a new step, and stays in bounds', () => {
  let walk = walkTo(NO_WALK, mara, walkStep(mara, tom, link('tom', 'mara', 'reports to')))
  expect(walk.steps.map((s) => s.id)).toEqual(['mara', 'tom'])
  walk = walkTo(walk, null, walkStep(tom, rina, link('tom', 'rina', 'took over from')))
  expect(walk.index).toBe(2)
  walk = moveWalk(moveWalk(moveWalk(walk, -1), -1), -1)
  expect(walk.index).toBe(0)
  walk = moveWalk(walk, 1)
  walk = walkTo(walk, null, walkStep(tom, mara, null))
  expect(walk.steps.map((s) => s.id)).toEqual(['mara', 'tom', 'mara'])
  expect(moveWalk(walk, 5).index).toBe(2)
  expect(walkTo(walk, null, walkStep(mara, mara, null))).toEqual(walk)
})
