import { afterEach, expect, it } from 'vitest'
import { extractJob } from './extract'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function setup() {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  const run = () =>
    extractJob(s.store.job(s.job.id)!, new AbortController().signal, s.store, s.options, s.search)
  await run()
  // Validated windows from an older extractor have the same names but older prompt hashes.
  for (const [key, part] of [...s.store.parts]) {
    if (part.part !== 'w1' && part.part !== 'links:w1') continue
    s.store.parts.delete(key)
    s.store.savePart(s.job.id, { ...part, inputHash: 'older-extractor-prompt' })
  }
  s.runner.mockClear()
  return { ...s, run }
}

it('a failed refresh Retry reuses extract and links windows even after becoming running', async () => {
  const s = await setup()
  s.store.matches = [[{ entityId: 'rina', channel: 'name', score: 1 }]]
  s.store.cards = [
    {
      id: 'rina',
      label: 'Rina Okafor',
      aliases: [],
      kind: 'person',
      description: 'Ledger lead',
      neighbours: [],
      memories: 1,
    },
  ]
  s.store.rev++
  s.store.updateJob(s.job.id, { state: 'refreshing' })
  s.runner.mockRejectedValueOnce(new Error('Reader timed out'))
  await expect(s.run()).rejects.toThrow('Reader timed out')
  s.store.updateJob(s.job.id, { state: 'failed' })
  s.store.retry(s.job.id)
  s.store.updateJob(s.job.id, { state: 'running' })
  s.runner.mockClear()
  await s.run()
  expect(s.runner.mock.calls.filter(([call]) => ['extract', 'links'].includes(call.stage))).toEqual(
    [],
  )
  expect(s.runner.mock.calls.map(([call]) => call.stage)).toEqual(['identity'])
})
it.each(['proposal', 'prepare'] as const)(
  'a v6-style queued recompute reuses saved windows by %s',
  async (checkpoint) => {
    const s = await setup()
    if (checkpoint === 'prepare') s.store.proposals.clear()
    else {
      for (const [key, part] of s.store.parts)
        if (part.part === 'prepare') s.store.parts.delete(key)
    }
    s.store.updateJob(s.job.id, { state: 'queued' })
    s.store.updateJob(s.job.id, { state: 'running' })
    await s.run()
    expect(
      s.runner.mock.calls.filter(([call]) => ['extract', 'links'].includes(call.stage)),
    ).toEqual([])
    expect(s.store.job(s.job.id)?.state).toBe('review')
  },
)
