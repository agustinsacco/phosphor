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
    truncated: false,
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
  expect(job.evidence).toHaveLength(1)
  expect(job.outcomes.some((o) => o.candidate === 'w2:c1' && o.status === 'folded')).toBe(true)
})
