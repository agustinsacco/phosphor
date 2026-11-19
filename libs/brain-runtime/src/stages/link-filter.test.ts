import { expect, it } from 'vitest'
import { extractWindows } from './extract'
import { FakeBrainStore, HARBOR_JOB } from '../__fixtures__/fake-store'
import { trackAsk } from '../__fixtures__/stage-ask'
import { makeWindow } from '../windows'

const text =
  'Rina Okafor uses Kestrel daily and prefers Kestrel over Ledger. Rina Okafor owns and works on Harbor. Tom Lee uses Kestrel for exports.'
const entity = (ref: string, label: string, kind: string) => ({
  ref,
  label,
  kind,
  aliases: [],
  description: '',
  keys: [],
})
const link = (subject: string, predicate: string, object: string, quote: string) => ({
  subject,
  predicate,
  object,
  segment: 's1',
  quote,
})
const claim = (ref: string, mentions: string[], links: unknown[], quote: string) => ({
  ref,
  text: quote,
  type: 'fact',
  epistemic: 'reported',
  mentions,
  links,
  validFrom: null,
  validTo: null,
  branch: false,
  quotes: [{ segment: 's1', quote }],
})
function answer(user: boolean) {
  const uses = 'Rina Okafor uses Kestrel daily'
  const owns = 'Rina Okafor owns and works on Harbor.'
  const tom = 'Tom Lee uses Kestrel for exports.'
  return {
    entities: [
      { ...entity('n1', 'Rina Okafor', 'person'), ...(user ? { user: true } : {}) },
      entity('n2', 'Harbor', 'project'),
      entity('n3', 'Kestrel', 'component'),
      entity('n4', 'Tom Lee', 'person'),
    ],
    claims: [
      claim('c1', ['n1', 'n3'], [link('n1', 'uses', 'n3', uses)], uses),
      claim(
        'c2',
        ['n1', 'n2'],
        [link('n1', 'owns', 'n2', owns), link('n1', 'works_on', 'n2', owns)],
        owns,
      ),
      claim('c3', ['n4', 'n3'], [link('n4', 'uses', 'n3', tom)], tom),
    ],
    parents: [],
  }
}
/** The links pass adds the owner's preference, which the extract answer left out. */
const added = [
  {
    claim: 'c1',
    ...link('n1', 'prefers', 'n3', 'prefers Kestrel over Ledger'),
  },
]
async function extract(user: boolean) {
  const source = [{ entryId: 'u', role: 'user' as const, label: 'You', observedAt: 0, text }]
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const ask = trackAsk(async (stage, _part, _prompt, validate) =>
    validate(JSON.stringify(stage === 'extract' ? answer(user) : { links: added })),
  )
  const parts = await extractWindows(job.id, [makeWindow(source)], store, ask.ask, () => {}, source)
  return parts[0]!.extraction
}
const predicates = (extraction: Awaited<ReturnType<typeof extract>>) =>
  extraction.claims.map((c) => c.links.map((l) => `${l.subject} ${l.predicate} ${l.object}`))

it("drops the owner's uses and prefers links, from both calls, and keeps everyone else's", async () => {
  const extraction = await extract(true)
  expect(predicates(extraction)).toEqual([[], ['w1:n1 owns w1:n2'], ['w1:n4 uses w1:n3']])
  expect(extraction.outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        candidate: 'w1:c1:link-filter:1',
        summary: 'Rina Okafor uses Kestrel',
        status: 'dropped',
      }),
      expect.objectContaining({
        candidate: 'w1:c1:link-filter:2',
        summary: 'Rina Okafor prefers Kestrel',
        status: 'dropped',
      }),
    ]),
  )
  const candidates = (extraction.outcomes ?? []).map((o) => o.candidate)
  expect(new Set(candidates).size).toBe(candidates.length)
})

it('collapses owns and works_on for one pair in one claim to owns, with or without an owner', async () => {
  const extraction = await extract(false)
  expect(predicates(extraction)).toEqual([
    ['w1:n1 uses w1:n3', 'w1:n1 prefers w1:n3'],
    ['w1:n1 owns w1:n2'],
    ['w1:n4 uses w1:n3'],
  ])
  expect(extraction.outcomes).toContainEqual(
    expect.objectContaining({
      candidate: 'w1:c2:link-filter:2',
      summary: 'Rina Okafor works_on Harbor',
      status: 'dropped',
      reason: 'Owns already says this: works_on for the same pair is dropped',
    }),
  )
})
