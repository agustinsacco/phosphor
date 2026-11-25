import { extraction } from '@phosphor/memory-engine/test-support'
import { expect, it } from 'vitest'
import { extractWindows } from './extract'
import { FakeBrainStore, HARBOR_JOB } from '../__fixtures__/fake-store'
import { RAW_EXTRACTION } from '../__fixtures__/lane'
import { trackAsk } from '../__fixtures__/stage-ask'
import { inputHash, makeWindow } from '../windows'
import { rebuildPrompt } from '../stage-input'
import type { StageExtraction, StageInput, StageLinks } from '../stage-types'
import { BRAIN_LINK_RULES } from '@phosphor/shared/brain'

const quote = 'Rina Okafor owns Harbor billing.'
const link = { claim: 'c1', ...RAW_EXTRACTION.claims[0]!.links[0]! }
function fixture(): StageExtraction {
  const value = structuredClone(RAW_EXTRACTION)
  value.claims[0]!.links = []
  return value
}
function segments(texts: string[]) {
  return texts.map((text, i) => ({
    entryId: `e${i}`,
    role: 'user' as const,
    label: 'You',
    observedAt: 0,
    text,
  }))
}
async function extract(value = fixture(), links: unknown[] = [link], texts = [quote]) {
  const source = segments(texts)
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const ask = trackAsk(async (stage, _part, _prompt, validate) =>
    validate(JSON.stringify(stage === 'extract' ? value : { links })),
  )
  const parts = await extractWindows(job.id, [makeWindow(source)], store, ask.ask, () => {}, source)
  return { extraction: parts[0]!.extraction, ask, store, job, source }
}
function linksCall(s: Awaited<ReturnType<typeof extract>>) {
  const call = s.ask.spy.mock.calls.find(([stage]) => stage === 'links')
  expect(call, 'one links call after the extract call').toBeDefined()
  return call!
}
it('skips claims with fewer than two entities, then calls links immediately after each eligible part', async () => {
  const value = fixture()
  value.claims[0]!.mentions = ['n1']
  const skipped = await extract(value)
  expect(skipped.ask.spy.mock.calls.map(([stage]) => stage)).toEqual(['extract'])
  const kept = await extract()
  expect(kept.ask.spy.mock.calls.map(([stage]) => stage)).toEqual(['extract', 'links'])
  expect(kept.extraction.claims[0]!.links).toMatchObject([{ subject: 'w1:n1', object: 'w1:n2' }])
})
it('puts fixed rules first, then only mentioned entities and rows with existing links and excerpts', async () => {
  const value = fixture()
  value.claims[0]!.links = [link]
  value.entities.push({ ...value.entities[1]!, ref: 'n3', label: 'Ledger' })
  const s = await extract(value, [])
  const prompt = linksCall(s)[2] as string
  expect(prompt.startsWith('# Task\nEach claim below was kept for a long-term memory.')).toBe(true)
  expect(prompt).toContain('An empty "links" list is a correct answer.')
  for (const [predicate, rule] of Object.entries(BRAIN_LINK_RULES))
    expect(prompt).toContain(`${predicate}: ${rule.subject.join(', ')} → ${rule.object.join(', ')}`)
  expect(prompt).toContain(
    'Entities: ' +
      JSON.stringify(
        value.entities
          .slice(0, 2)
          .map(({ ref, kind, label, description }) => ({ ref, kind, label, description })),
      ),
  )
  expect(prompt).not.toContain('Ledger')
  expect(prompt).toContain(`[c1] ${quote}\nmentions: n1, n2\nhas: n1 owns n2\n[s1] ${quote}`)
  expect(prompt.indexOf('# Rules')).toBeLessThan(prompt.indexOf('Entities:'))
})
it('bounds each excerpt to 600 characters on either side and stores only source offsets', async () => {
  const text = 'x'.repeat(700) + quote + 'y'.repeat(700)
  const s = await extract(fixture(), [], [text, 'Other segment must not leak'])
  const call = linksCall(s)
  expect(call[2]).toContain(`[s1] ${'x'.repeat(600)}${quote}${'y'.repeat(600)}`)
  expect(call[2]).not.toContain('x'.repeat(601))
  expect(call[2]).not.toContain('y'.repeat(601))
  expect(call[2]).not.toContain('Other segment')
  expect(call[2]).toContain('has: none')
  const input = call[5] as StageInput
  expect(JSON.stringify(input)).not.toContain('x'.repeat(50))
  expect(JSON.stringify(input)).toContain('"start":100')
  expect(JSON.stringify(input)).toContain(`"end":${1300 + quote.length}`)
  expect(inputHash(rebuildPrompt('links', input, s.source))).toBe(inputHash(call[2]))
})
it('stops excerpts at elision markers and merges overlapping excerpts in their own segment', async () => {
  const value = fixture()
  value.claims[0]!.quotes.push({ segment: 's1', quote: 'Harbor uses Ledger.' })
  value.claims[0]!.quotes.push({ segment: 's2', quote: 'Kestrel.' })
  const s = await extract(
    value,
    [],
    [
      `Hidden left[… 9000 chars omitted …]${quote} Harbor uses Ledger.[… 9000 chars omitted …]Hidden right`,
      'Kestrel.',
    ],
  )
  const prompt = linksCall(s)[2] as string
  expect(prompt).toContain(`[s1] ${quote} Harbor uses Ledger.\n[s2] Kestrel.`)
  expect(prompt.match(/\[s1\]/g)).toHaveLength(1)
  expect(prompt).not.toContain('Hidden')
  expect(prompt).not.toContain('chars omitted')
})
it.each([
  ['claim outside rows', { claim: 'c2' }, 'Unknown links claim'],
  ['unmentioned subject', { subject: 'n3' }, 'not mentioned'],
  ['unmentioned object', { object: 'n3' }, 'not mentioned'],
  ['self link', { object: 'n1' }, 'itself'],
  ['unknown predicate', { predicate: 'invented' }, 'Unknown vocabulary'],
  ['wrong endpoint kinds', { predicate: 'part_of' }, 'Invalid endpoint kinds'],
  ['unverified quote', { quote: 'Ledger is missing.' }, 'Quote not found'],
  [
    'quote resolves outside excerpts',
    { segment: 's1', quote: 'Tom Lee owns Ledger.' },
    "Link quote is not from this claim's excerpts",
  ],
  ['sensitive invalid value', { predicate: 'Bearer harbor-secret' }, '[redacted]'],
] as const)('drops %s alone and records a scrubbed outcome', async (_name, patch, reason) => {
  const value = fixture()
  value.entities.push({ ...value.entities[1]!, ref: 'n3', label: 'Ledger' })
  value.claims.push({ ...structuredClone(value.claims[0]!), ref: 'c2', mentions: ['n1'] })
  const s = await extract(value, [{ ...link, ...patch }, link], [quote, 'Tom Lee owns Ledger.'])
  expect(s.extraction.outcomes ?? []).toContainEqual(
    expect.objectContaining({ status: 'dropped', reason: expect.stringContaining(reason) }),
  )
  expect(s.extraction.claims[0]!.links).toHaveLength(1)
  expect(s.extraction.claims[0]!.mentions).toEqual(['w1:n1', 'w1:n2'])
  expect(JSON.stringify(s.extraction)).not.toContain('harbor-secret')
})
it('drops duplicates anywhere in the part, from extraction or earlier answer rows, first wins', async () => {
  const value = fixture()
  value.claims.push({ ...structuredClone(value.claims[0]!), ref: 'c2', links: [link] })
  const s = await extract(value, [link])
  expect(s.extraction.outcomes ?? []).toContainEqual(
    expect.objectContaining({ reason: expect.stringContaining('Duplicate link') }),
  )
  expect(s.extraction.claims.map((c) => c.links.length)).toEqual([0, 1])
  const t = await extract(fixture(), [link, link])
  expect(t.extraction.claims[0]!.links).toHaveLength(1)
  expect(t.extraction.outcomes ?? []).toContainEqual(
    expect.objectContaining({ reason: expect.stringContaining('Duplicate link') }),
  )
})
it('stores flexible-whitespace quotes as the source substring and resolved excerpt segment', async () => {
  const source = 'Rina  Okafor owns\nHarbor billing.'
  const s = await extract(fixture(), [{ ...link, segment: 's9' }], [source])
  expect(s.extraction.claims[0]!.links).toMatchObject([{ segment: 's1', quote: source }])
})
it.each(['part_of', 'uses'] as const)(
  'updates an unstated parent only for a structural %s link',
  async (predicate) => {
    const value = fixture()
    value.entities[0]!.kind = 'component'
    value.parents.push({ entity: 'n1', status: 'not_stated', claim: null })
    const s = await extract(value, [{ ...link, predicate }])
    expect(s.extraction.claims[0]!.links).toHaveLength(1)
    expect(s.extraction.parents.find((p) => p.entity === 'w1:n1')).toEqual({
      entity: 'w1:n1',
      status: predicate === 'part_of' ? 'stated' : 'not_stated',
      claim: predicate === 'part_of' ? 'w1:c1' : null,
    })
  },
)
it('checkpoints the validated links separately without contaminating the extraction checkpoint', async () => {
  const s = await extract()
  const call = linksCall(s)
  expect(s.store.part(s.job.id, 'links:w1', inputHash(call[2]))).toBeDefined()
  const original = s.store.part(s.job.id, 'w1', inputHash(s.ask.spy.mock.calls[0]![2]))!
  expect(JSON.parse(original.output).claims[0].links).toEqual([])
  const retry = trackAsk()
  const parts = await extractWindows(
    s.job.id,
    [makeWindow(s.source)],
    s.store,
    retry.ask,
    () => {},
    s.source,
  )
  expect(retry.spy).not.toHaveBeenCalled()
  expect(parts[0]!.extraction).toEqual(s.extraction)
})
it('offers registry entities and renames links only after each part has its links', async () => {
  const source = segments([quote, quote])
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const stages: string[] = []
  const ask = trackAsk(async (stage, _part, prompt, validate) => {
    stages.push(stage)
    const second = stages.filter((s) => s === 'extract').length === 2
    const value = fixture()
    if (second) {
      value.entities = []
      value.claims[0]!.mentions = ['r1', 'r2']
    }
    if (stage === 'extract') return validate(JSON.stringify(value))
    expect(prompt).toContain(second ? 'mentions: r1, r2' : 'mentions: n1, n2')
    return validate(JSON.stringify({ links: second ? [] : [link] }))
  })
  await extractWindows(
    job.id,
    source.map((s) => makeWindow([s])),
    store,
    ask.ask,
    () => {},
    source,
  )
  expect(stages).toEqual(['extract', 'links', 'extract', 'links'])
})
it('matches a flexible quote in the claim excerpt even when an earlier segment words it alike', async () => {
  const s = await extract(
    fixture(),
    [{ ...link, segment: 's2', quote: 'Rina Okafor  owns Harbor billing.' }],
    ['Rina Okafor owns\nHarbor billing. Tom Lee asked first.', quote],
  )
  expect(s.extraction.claims[0]!.quotes).toMatchObject([{ segment: 's2' }])
  expect(s.extraction.outcomes ?? []).toEqual([])
  expect(s.extraction.claims[0]!.links).toMatchObject([{ segment: 's2', quote }])
})
it('builds the excerpt around the quoted words, never around the same words inside an elision marker', async () => {
  const value = fixture()
  value.claims[0]!.quotes = [{ segment: 's1', quote: '9000 chars omitted' }]
  const s = await extract(
    value,
    [],
    [`Old notes.[… 9000 chars omitted …] Kestrel said 9000 chars omitted. ${quote}`],
  )
  const prompt = linksCall(s)[2] as string
  expect(prompt).toContain(`[s1]  Kestrel said 9000 chars omitted. ${quote}`)
  expect(prompt).not.toContain('Old notes.')
})

it('reuses an old-hash parsed links part on a resumed read without re-reading its source excerpts', async () => {
  const s = await extract()
  for (const [key, part] of [...s.store.parts]) {
    if (part.part !== 'links:w1') continue
    s.store.parts.delete(key)
    s.store.savePart(s.job.id, { ...part, inputHash: 'old-link-rules' })
  }
  s.store.updateJob(s.job.id, { state: 'running' })
  s.store.proposals.set(s.job.id, extraction(s.job.id))
  s.store.savePart(s.job.id, {
    part: 'prepare',
    inputHash: 'frozen-v4',
    output: '{}',
    prepare: { leafId: s.job.leafId, model: s.job.model, branch: s.job.branch },
  })
  const ask = trackAsk(async (_stage, _part, _prompt, validate) =>
    validate(JSON.stringify({ links: [] })),
  )
  const parts = await extractWindows(
    s.job.id,
    [makeWindow(s.source)],
    s.store,
    ask.ask,
    () => {},
    s.source,
  )
  expect(ask.spy).not.toHaveBeenCalled()
  expect(parts[0]!.extraction.claims[0]!.links).toMatchObject([{ predicate: 'owns' }])
})

it('filters the links a resumed read reuses from a part saved before the link rules', async () => {
  const value = fixture()
  value.entities[0] = { ...value.entities[0]!, user: true }
  const s = await extract(value)
  for (const [key, part] of [...s.store.parts]) {
    if (part.part !== 'links:w1') continue
    const saved = JSON.parse(part.output) as StageLinks
    saved.links.push({ ...link, predicate: 'works_on' }, { ...link, predicate: 'prefers' })
    s.store.parts.delete(key)
    s.store.savePart(s.job.id, { ...part, inputHash: 'old', output: JSON.stringify(saved) })
  }
  s.store.updateJob(s.job.id, { state: 'running' })
  s.store.proposals.set(s.job.id, extraction(s.job.id))
  s.store.savePart(s.job.id, {
    part: 'prepare',
    inputHash: 'frozen-v4',
    output: '{}',
    prepare: { leafId: s.job.leafId, model: s.job.model, branch: s.job.branch },
  })
  const ask = trackAsk()
  const parts = await extractWindows(
    s.job.id,
    [makeWindow(s.source)],
    s.store,
    ask.ask,
    () => {},
    s.source,
  )
  expect(ask.spy).not.toHaveBeenCalled()
  const reused = parts[0]!.extraction
  expect(reused.claims[0]!.links.map((l) => l.predicate)).toEqual(['owns'])
  expect(reused.outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        candidate: 'w1:c1:link-filter:2',
        reason: 'Owns already says this: works_on for the same pair is dropped',
      }),
      expect.objectContaining({
        candidate: 'w1:c1:link-filter:3',
        reason: 'The user is never linked to something they only use or prefer',
      }),
    ]),
  )
})
