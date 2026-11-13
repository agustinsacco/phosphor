import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { extractJob } from './extract'
import { pipelineSetup, answerFor } from './__fixtures__/pipeline'
import { RAW_EXTRACTION } from './__fixtures__/lane'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function setup() {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  return s
}
const signal = () => new AbortController().signal

it('extracts windows, resolves, embeds and proposes with progress, summed usage and per-call records', async () => {
  const s = await setup()
  await extractJob(s.job, signal(), s.store, s.options, s.search)
  const p = s.store.storedProposal(s.job.id)!
  expect(p.memories[0]).toMatchObject({
    summary: RAW_EXTRACTION.claims[0]!.text,
    action: 'add',
    links: [{ predicate: 'owns' }],
  })
  expect(p.computedRevision).toBe(0)
  expect(p.memoryVectors).toHaveLength(1)
  expect(s.store.job(s.job.id)).toMatchObject({
    state: 'review',
    usage: { tokens: 30, cost: 0 },
    progress: { stage: 'embed', done: 1, total: 1 },
  })
  expect(s.store.extraction(s.job.id).calls.map((c) => c.stage)).toEqual([
    'extract',
    'identity',
    'parents',
  ])
  expect(s.store.extraction(s.job.id).outcomes).toContainEqual(
    expect.objectContaining({ candidate: 'w1:c1', status: 'kept' }),
  )
  expect(JSON.stringify(s.options.log.mock.calls)).not.toContain(RAW_EXTRACTION.claims[0]!.text)
})
it('unknown ref triggers one repair, never an about link; a second invalid answer visibly fails', async () => {
  const s = await setup(),
    bad = structuredClone(RAW_EXTRACTION)
  bad.claims[0]!.links[0]!.object = 'missing'
  s.runner.mockImplementation(async (input) => ({
    text: input.stage === 'extract' ? JSON.stringify(bad) : answerFor(input),
    usage: { tokens: 7, cost: 0 },
  }))
  await extractJob(s.job, signal(), s.store, s.options, s.search)
  expect(s.runner.mock.calls.map(([c]) => c.stage)).toEqual([
    'extract',
    'repair',
    'identity',
    'parents',
  ])
  expect(s.runner.mock.calls[1]![0].prompt).toContain('Unknown entity ref: missing')
  expect(s.store.storedProposal(s.job.id)!.memories[0]!.links[0]!.predicate).toBe('owns')
  expect(s.store.extraction(s.job.id).calls[0]!.error).toContain('Unknown entity ref')
  const t = await setup()
  t.runner.mockResolvedValue({ text: JSON.stringify(bad), usage: { tokens: 5, cost: 0 } })
  await expect(extractJob(t.job, signal(), t.store, t.options, t.search)).rejects.toThrow(
    'validation failed after repair',
  )
  expect(t.runner).toHaveBeenCalledTimes(2)
  expect(t.store.extraction(t.job.id).error).toContain('Unknown entity ref')
})
it('retry keeps the frozen leaf/model/branch and reuses validated extract parts', async () => {
  const s = await setup()
  let fail = true
  s.runner.mockImplementation(async (input) => {
    if (input.stage === 'parents' && fail) throw new Error('Fake transport error')
    return { text: answerFor(input), usage: { tokens: 10, cost: 0 } }
  })
  await expect(extractJob(s.job, signal(), s.store, s.options, s.search)).rejects.toThrow(
    'Fake transport',
  )
  const leaf = s.store.job(s.job.id)!.leafId
  await appendFile(
    s.file,
    '\n' +
      JSON.stringify({
        id: 'later',
        type: 'model_change',
        provider: 'other',
        modelId: 'different',
      }),
  )
  s.store.updateJob(s.job.id, { state: 'failed' })
  s.store.retry(s.job.id)
  fail = false
  await extractJob(s.job, signal(), s.store, s.options, s.search)
  expect(s.runner.mock.calls.filter(([c]) => c.stage === 'extract')).toHaveLength(1)
  expect(s.store.job(s.job.id)).toMatchObject({ leafId: leaf, model: 'example/fast' })
  expect(s.runner.mock.calls.every(([c]) => c.lane.leafId === leaf)).toBe(true)
})
it('auto-approves review-off jobs and refreshes the reader', async () => {
  const s = await setup()
  s.store.prefs.review = false
  await extractJob(s.job, signal(), s.store, s.options, s.search)
  expect(s.store.reviews).toEqual([
    { id: s.job.id, decision: { memories: [0], identities: {}, groups: [] } },
  ])
  expect(s.search.refreshes).toBe(1)
})
it('does not propose after cancellation while embedding, and scrubs failed call records', async () => {
  const s = await setup(),
    controller = new AbortController()
  const embed = s.options.embeddings.embed
  s.options.embeddings.embed = vi.fn(async (...args) => {
    controller.abort()
    return embed(args[0], args[1], args[2])
  })
  await expect(extractJob(s.job, controller.signal, s.store, s.options, s.search)).rejects.toThrow()
  expect(s.store.storedProposal(s.job.id)).toBeUndefined()
  const t = await setup()
  t.runner.mockRejectedValue(new Error('Bearer harbor-secret'))
  await expect(extractJob(t.job, signal(), t.store, t.options, t.search)).rejects.toThrow()
  expect(JSON.stringify(t.store.extraction(t.job.id))).not.toContain('harbor-secret')
})

it('keeps an outcome for each validated claim when a later stage fails', async () => {
  const s = await setup()
  vi.mocked(s.options.embeddings.embed).mockRejectedValueOnce(new Error('Fake embedding failure'))
  await expect(extractJob(s.job, signal(), s.store, s.options, s.search)).rejects.toThrow(
    'Fake embedding failure',
  )
  expect(s.store.extraction(s.job.id).outcomes).toContainEqual(
    expect.objectContaining({
      candidate: 'w1:c1',
      status: 'dropped',
      reason: 'Run failed before proposal',
    }),
  )
})

it('publishes extract progress before the first model call begins',async()=>{
  const s=await setup()
  s.runner.mockImplementation(async input=>{
    if(input.stage==='extract')expect(s.store.job(s.job.id)?.progress).toEqual({stage:'extract',done:0,total:1})
    return {text:answerFor(input),usage:{tokens:1,cost:0}}
  })
  await extractJob(s.job,signal(),s.store,s.options,s.search)
})
