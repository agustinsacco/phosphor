import { expect, it } from 'vitest'
import { foldParts } from './fold'
import { RAW_EXTRACTION } from '../__fixtures__/lane'
import { makeWindow } from '../windows'
it('folds equal claims and links across overlapping windows with merged evidence and aliases', () => {
  const window = makeWindow([
    {
      entryId: 'u',
      role: 'user',
      label: 'You',
      observedAt: 0,
      text: RAW_EXTRACTION.claims[0]!.text,
    },
  ])
  const parts = ['w1', 'w2'].map((key) => ({
    key,
    window,
    extraction: {
      ...structuredClone(RAW_EXTRACTION),
      entities: RAW_EXTRACTION.entities.map((e) => ({ ...e, ref: `${key}:${e.ref}` })),
      claims: RAW_EXTRACTION.claims.map((c) => ({
        ...c,
        ref: `${key}:${c.ref}`,
        mentions: c.mentions.map((id) => `${key}:${id}`),
        links: c.links.map((l) => ({
          ...l,
          subject: `${key}:${l.subject}`,
          object: `${key}:${l.object}`,
        })),
      })),
    },
  }))
  const job = foldParts(parts, 'harbor')
  expect(job.entities).toHaveLength(2)
  expect(job.claims).toHaveLength(1)
  expect(job.claims[0]!.memory.citations).toHaveLength(1)
  // Older checkpointed parts have neither a label nor an importance.
  expect(job.claims[0]?.memory).toMatchObject({
    importance: 1,
    links: expect.arrayContaining([expect.objectContaining({ label: '' })]),
  })
  expect(job.evidence).toHaveLength(1)
  expect(job.outcomes.some((o) => o.candidate === 'w2:c1' && o.status === 'folded')).toBe(true)
})

it('records every link rejected because folded endpoints became the same entity', () => {
  const extraction = structuredClone(RAW_EXTRACTION)
  extraction.entities[0] = { ...extraction.entities[1]!, ref: 'n1' }
  const window = makeWindow([
    {
      entryId: 'u',
      role: 'user',
      label: 'You',
      observedAt: 0,
      text: RAW_EXTRACTION.claims[0]!.text,
    },
  ])
  const job = foldParts([{ key: 'w1', window, extraction }], 'lane')
  expect(job.claims[0]!.memory.links).toEqual([])
  expect(job.outcomes).toContainEqual(
    expect.objectContaining({
      candidate: 'c1:link:1',
      status: 'dropped',
      reason: 'Identity folding made both link endpoints the same entity',
    }),
  )
})

it('marks holds on claims from a part saved before holds existed, keeping a hold the model gave', () => {
  const said = [
    'Rina Okafor is currently reviewing Harbor billing.',
    'Rina Okafor is up for promotion this cycle.',
    'Harbor billing runs nightly.',
    'Harbor billing closes the books monthly.',
  ]
  const window = makeWindow([
    { entryId: 'u', role: 'user', label: 'You', observedAt: 0, text: said.join(' ') },
  ])
  const [base] = RAW_EXTRACTION.claims
  const claim = (ref: string, text: string, mentions: string[]) => {
    const { hold: _hold, ...saved } = { ...base!, hold: null }
    return { ...saved, ref, text, mentions, links: [], quotes: [{ segment: 's1', quote: text }] }
  }
  const extraction = {
    ...structuredClone(RAW_EXTRACTION),
    claims: [
      claim('c1', said[0]!, ['n1', 'n2']),
      claim('c2', said[1]!, ['n1']),
      claim('c3', said[2]!, ['n2']),
      { ...claim('c4', said[3]!, ['n2']), hold: 'temporary' as const },
    ],
  }
  expect(extraction.claims[0]).not.toHaveProperty('hold')
  const job = foldParts([{ key: 'w1', window, extraction }], 'lane')
  expect(job.claims.map((c) => [c.ref, c.memory.hold])).toEqual([
    ['c1', 'temporary'],
    ['c2', 'personal'],
    ['c3', null],
    ['c4', 'temporary'],
  ])
})
