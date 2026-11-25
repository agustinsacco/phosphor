import { expect, it } from 'vitest'
import type { BrainRecall } from '@shared/brain-recall'
import { graphFixture, graphLink } from '../__fixtures__/graph3D'
import { answerOverlay } from './useBrainScreen'

function recall(hits: BrainRecall['hits']): BrainRecall {
  const { entities } = graphFixture()
  return {
    mode: 'search',
    status: 'ok',
    hits,
    entities,
    focus: ['rina'],
    more: 0,
    branch: null,
    degradation: [],
  }
}

it('lights what a memory that names the question says, when no trail led to it', () => {
  const [, owner] = graphFixture().memories
  const overlay = answerOverlay(
    recall([{ memory: owner!, score: 1, reasons: ['exact'], trail: null }]),
  )
  expect(overlay.links.map((link) => link.id)).toEqual(['link-owner'])
  expect(overlay.entities.map((entity) => entity.id).sort()).toEqual(['harbor', 'rina'])
})

it('lights a trail and the memory at its end once each', () => {
  const [db, owner] = graphFixture().memories
  const hop = graphLink({
    id: 'link-owner',
    memoryId: 'owner',
    subjectId: 'rina',
    objectId: 'harbor',
    predicate: 'owns',
  })
  const overlay = answerOverlay(
    recall([
      {
        memory: db!,
        score: 1,
        reasons: ['linked'],
        trail: { seedId: 'rina', links: [hop], entityId: 'harbor' },
      },
      { memory: owner!, score: 0.5, reasons: ['exact'], trail: null },
    ]),
  )
  expect(overlay.links.map((link) => link.id).sort()).toEqual(['link-db', 'link-owner'])
  expect(overlay.entities.map((entity) => entity.id).sort()).toEqual(['harbor', 'postgres', 'rina'])
})
