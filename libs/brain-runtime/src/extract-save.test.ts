import { afterEach, expect, it, vi } from 'vitest'
import { BRAIN_READ_STALE } from '@phosphor/memory-engine/read-stale'
import { pipelineSetup, answerFor } from './__fixtures__/pipeline'
import { RAW_EXTRACTION } from './__fixtures__/lane'
import { extractJob } from './extract'

async function setup() {
  const s = await pipelineSetup()
  afterEach(s.cleanup)
  s.store.updateJob(s.job.id, {state: 'running'})
  return {...s, run: () => extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)}
}
it('reconciles against new candidates after a stale save, without rereading the source', async () => {
  const s = await setup()
  const reconcile = vi.spyOn(s.store, 'memoryMatches')
  vi.spyOn(s.store, 'saveRead').mockImplementationOnce(() => {
    s.store.rev++
    throw new Error(BRAIN_READ_STALE)
  })
  await s.run()
  expect(reconcile).toHaveBeenCalledTimes(2)
  expect(s.store.saved.get(s.job.id)?.computedRevision).toBe(1)
  expect(s.runner.mock.calls.filter(([c]) => c.stage === 'extract')).toHaveLength(1)
})
it('fails with the retry sentence after three stale saves', async () => {
  const s = await setup()
  const save = vi.spyOn(s.store, 'saveRead').mockImplementation(() => {throw new Error(BRAIN_READ_STALE)})
  await expect(s.run()).rejects.toThrow('Brain kept changing while this lane was read. Retry it.')
  expect(save).toHaveBeenCalledTimes(3)
})
it('saves a fresh stored proposal without calling a model', async () => {
  const s = await setup()
  s.store.proposals.set(s.job.id, { jobId: s.job.id, origin: {sessionId: s.job.sessionId, title: s.job.title}, branch: null, scope: '', computedRevision: 0, entities: [], groups: [], memories: [], confirmations: [], evidence: [], held: 0, memoryVectors: [], entityVectors: [] })
  await s.run()
  expect(s.runner).not.toHaveBeenCalled()
  expect(s.job.state).toBe('empty')
})
it('submits grouped siblings for a group suggestion in the saved read', async () => {
  const s = await setup()
  const extraction = structuredClone(RAW_EXTRACTION)
  for (const [i, label] of ['Harbor Ledger', 'Harbor Kestrel', 'Harbor Northwind'].entries())
    extraction.entities.push({...extraction.entities[1]!, ref: `n${i+3}`, aliases: [], label})
  s.runner.mockImplementation(async (input) => ({text: input.stage === 'extract' ? JSON.stringify(extraction) : answerFor(input), usage: {cost: 0, tokens: 1}}))
  await s.run()
  expect(s.store.saved.get(s.job.id)?.groups).toEqual([expect.objectContaining({members: ['w1:n3','w1:n4','w1:n5']})])
})
