import { extraction } from '@phosphor/memory-engine/test-support'
import { trackAsk } from '../__fixtures__/stage-ask'
import { expect, it } from 'vitest'
import { extractWindows } from './extract'
import { foldParts } from './fold'
import { FakeBrainStore, HARBOR_JOB } from '../__fixtures__/fake-store'
import { makeWindow, transcriptWindows } from '../windows'
import type { StageAsk } from '../stage-types'
const empty = { entities: [], claims: [], parents: [] }
it('restart after window two resumes at window three under the same job id', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const segments = Array.from({ length: 4 }, (_, i) => ({
    entryId: `e${i}`,
    role: 'user' as const,
    label: 'You',
    observedAt: 0,
    text: `part ${i}`,
  }))
  let count = 0
  const ask: StageAsk = async (_s, _p, _prompt, validate) => {
    if (++count === 3) throw new Error('Killed')
    return validate(JSON.stringify(empty))
  }
  const windows = segments.map((s) => makeWindow([s]))
  await expect(extractWindows(job.id, windows, store, ask, () => {}, segments)).rejects.toThrow(
    'Killed',
  )
  const resumed = trackAsk(async (_s, _p, _prompt, validate) => validate(JSON.stringify(empty)))
  const parts = await extractWindows(job.id, windows, store, resumed.ask, () => {}, segments)
  expect(parts).toHaveLength(4)
  expect(resumed.spy).toHaveBeenCalledTimes(2)
  expect(resumed.spy.mock.calls[0]![2]).toContain('part 2')
})
it('does not split parts with many entities', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const segments = [0, 1].map((i) => ({
    entryId: `e${i}`,
    role: 'user' as const,
    label: 'You',
    observedAt: 0,
    text: 'Harbor',
  }))
  const capped = {
    ...empty,
    entities: Array.from({ length: 40 }, (_, i) => ({
      ref: `n${i + 1}`,
      label: `Concept ${i}`,
      kind: 'concept',
      aliases: [],
      description: '',
      keys: [],
    })),
  }
  const ask: StageAsk = async (_s, _p, _prompt, validate) => validate(JSON.stringify(capped))
  const parts = await extractWindows(
    job.id,
    transcriptWindows(segments),
    store,
    ask,
    () => {},
    segments,
  )
  expect(parts).toHaveLength(1)
})
it('a changed input hash never reuses a checkpoint', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued'),
    ask = trackAsk(async (_s, _p, _prompt, validate) => validate(JSON.stringify(empty)))
  for (const text of ['Harbor', 'Ledger']) {
    const segments = [{ entryId: 'e', role: 'user' as const, label: 'You', observedAt: 0, text }]
    await extractWindows(job.id, transcriptWindows(segments), store, ask.ask, () => {}, segments)
  }
  expect(ask.spy).toHaveBeenCalledTimes(2)
})

it('prioritizes registry names mentioned in the current window over recent unrelated entities', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const segments = ['many concepts', 'more concepts', 'Oldest concept matters'].map((text, i) => ({
    entryId: `e${i}`,
    role: 'user' as const,
    label: 'You',
    observedAt: 0,
    text,
  }))
  let call = 0
  const ask: StageAsk = async (_stage, _part, prompt, validate) => {
    call++
    if (call === 3) expect(prompt).toContain('"label":"Oldest concept"')
    const count = call === 1 ? 40 : call === 2 ? 30 : 0
    return validate(
      JSON.stringify({
        entities: Array.from({ length: count }, (_, i) => ({
          ref: `n${i + 1}`,
          label: call === 1 && i === 0 ? 'Oldest concept' : `Concept ${call}-${i}`,
          kind: 'concept',
          aliases: [],
          description: '',
          keys: [],
        })),
        claims: [],
        parents: [],
      }),
    )
  }
  await extractWindows(
    job.id,
    segments.map((s) => makeWindow([s])),
    store,
    ask,
    () => {},
    segments,
  )
})

it('tells later parts which claim sentences were already kept', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const segments = [0, 1].map((i) => ({
    entryId: `s${i}`,
    role: 'assistant' as const,
    label: 'Agent',
    observedAt: 0,
    text: 'Harbor requires billing approval.',
  }))
  const ask = trackAsk(async (_s, part, prompt, validate) => {
    if (part === 2) {
      expect(prompt).toContain(
        'Already kept from earlier parts of this conversation. Do not repeat them;',
      )
      expect(prompt).toContain('- Harbor requires billing approval.')
      expect(prompt).toContain('part 2 of 2:')
    }
    return validate(
      JSON.stringify({
        ...empty,
        claims: [
          {
            ref: 'c1',
            text: segments[0]!.text,
            type: 'fact',
            epistemic: 'reported',
            mentions: [],
            links: [],
            validFrom: null,
            validTo: null,
            branch: false,
            quotes: [{ segment: 's1', quote: segments[0]!.text }],
          },
        ],
      }),
    )
  })
  await extractWindows(
    job.id,
    segments.map((s) => makeWindow([s])),
    store,
    ask.ask,
    () => {},
    segments,
  )
})

it('keeps dropped outcome refs local to their part', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const segments = [
    { entryId: 'e', role: 'user' as const, label: 'You', observedAt: 0, text: 'Harbor' },
  ]
  const ask = trackAsk(async (_s, _p, _prompt, validate) =>
    validate(JSON.stringify({ ...empty, claims: [{ ref: 'c1' }] })),
  )
  const parts = await extractWindows(
    job.id,
    [makeWindow(segments)],
    store,
    ask.ask,
    () => {},
    segments,
  )
  expect(parts[0]!.extraction.outcomes?.[0]).toMatchObject({
    candidate: 'w1:c1',
    status: 'dropped',
  })
})

it("supplies a prior read's already-kept summaries to the first part", async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  const segments = [
    {
      entryId: 'new',
      role: 'user' as const,
      label: 'You',
      observedAt: 0,
      text: 'Harbor bills monthly.',
    },
  ]
  const ask = trackAsk(async (_s, _p, prompt, validate) => {
    expect(prompt).toContain('Already kept from earlier parts of this conversation.')
    expect(prompt).toContain('- Rina Okafor leads Ledger.')
    return validate(JSON.stringify(empty))
  })
  await extractWindows(job.id, [makeWindow(segments)], store, ask.ask, () => {}, segments, [
    'Rina Okafor leads Ledger.',
  ])
  expect(ask.spy).toHaveBeenCalledOnce()
})

it.each([true, false])(
  'uses an old-hash parsed window only with a saved checkpoint (legacy=%s)',
  async (legacy) => {
    const store = new FakeBrainStore(),
      job = store.enqueue(HARBOR_JOB, 'queued')
    store.updateJob(job.id, { state: 'running' })
    if (legacy) {
      store.proposals.set(job.id, extraction(job.id))
      store.savePart(job.id, {
        part: 'prepare',
        inputHash: 'frozen-v4',
        output: '{}',
        prepare: { leafId: job.leafId, model: job.model, branch: job.branch },
      })
    }
    const source = [
      {
        entryId: 'new',
        role: 'user' as const,
        label: 'You',
        observedAt: 0,
        text: 'Harbor bills monthly.',
      },
    ]
    store.savePart(job.id, {
      part: 'w1',
      inputHash: 'old-extractor-prompt',
      output: JSON.stringify(empty),
    })
    const ask = trackAsk(async (_s, _p, _prompt, validate) => validate(JSON.stringify(empty)))
    await extractWindows(job.id, [makeWindow(source)], store, ask.ask, () => {}, source)
    expect(ask.spy).toHaveBeenCalledTimes(legacy ? 0 : 1)
  },
)
it('extracts a missing saved window normally on a resumed read', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  store.updateJob(job.id, { state: 'running' })
  const source = [
    {
      entryId: 'new',
      role: 'user' as const,
      label: 'You',
      observedAt: 0,
      text: 'Harbor bills monthly.',
    },
  ]
  const ask = trackAsk(async (_s, _p, _prompt, validate) => validate(JSON.stringify(empty)))
  await extractWindows(job.id, [makeWindow(source)], store, ask.ask, () => {}, source)
  expect(ask.spy).toHaveBeenCalledOnce()
})

it('marks holds on claims a resumed read reuses from a window saved before holds existed', async () => {
  const store = new FakeBrainStore(),
    job = store.enqueue(HARBOR_JOB, 'queued')
  store.updateJob(job.id, { state: 'running' })
  store.proposals.set(job.id, extraction(job.id))
  store.savePart(job.id, {
    part: 'prepare',
    inputHash: 'frozen-v4',
    output: '{}',
    prepare: { leafId: job.leafId, model: job.model, branch: job.branch },
  })
  const text = 'Harbor currently bills weekly.'
  const source = [{ entryId: 'new', role: 'user' as const, label: 'You', observedAt: 0, text }]
  const harbor = { ref: 'n1', label: 'Harbor', kind: 'project', aliases: [], description: '' }
  const saved = {
    entities: [{ ...harbor, keys: [] }],
    claims: [
      {
        ...{ ref: 'c1', text, type: 'fact', epistemic: 'reported', mentions: ['n1'], links: [] },
        ...{ quotes: [{ segment: 's1', quote: text }], validFrom: null, validTo: null },
        branch: false,
      },
    ],
    parents: [],
  }
  store.savePart(job.id, { part: 'w1', inputHash: 'old-extractor', output: JSON.stringify(saved) })
  const ask = trackAsk()
  const parts = await extractWindows(job.id, [makeWindow(source)], store, ask.ask, () => {}, source)
  expect(ask.spy).not.toHaveBeenCalled()
  expect(parts[0]!.extraction.claims[0]).not.toHaveProperty('hold')
  expect(foldParts(parts, 'lane').claims[0]!.memory.hold).toBe('temporary')
})
