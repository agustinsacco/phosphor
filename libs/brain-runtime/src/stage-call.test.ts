import { afterEach, expect, it, vi } from 'vitest'
import { stageCaller } from './stage-call'
import { pipelineSetup } from './__fixtures__/pipeline'
import { readLane } from './lane'
import { ExtractionRecord } from './extraction-record'
import { CallTracer } from './call-trace'
import { inputHash } from './windows'
import type { BrainServiceOptions } from './types'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f()
})
async function setup() {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  const controller = new AbortController()
  const delay = vi.fn(async () => {})
  const options: BrainServiceOptions = { ...s.options, retryDelay: delay }
  const record = new ExtractionRecord(s.job, s.store, Date.now, 'medium')
  const ask = await stageCaller({
    job: s.job,
    lane: await readLane(s.file),
    store: s.store,
    options,
    signal: controller.signal,
    record,
  })
  return { ...s, controller, delay, ask }
}
function failure(reason: 'error' | 'no-text' | 'aborted' | 'timeout') {
  const tracer = new CallTracer()
  tracer.event({
    type: 'message_end',
    message: { role: 'assistant', usage: { totalTokens: 5, cost: { total: 0.1 } } },
  })
  tracer.finish(reason)
  return tracer.trace
}
it.each(['error', 'no-text'] as const)(
  'retries %s once with distinct checkpoints and counts both attempts',
  async (reason) => {
    const s = await setup()
    s.runner
      .mockImplementationOnce(async (input) => {
        input.onTrace?.(failure(reason))
        throw new Error('Socket closed')
      })
      .mockResolvedValueOnce({ text: 'ok', usage: { tokens: 10, cost: 0.2 } })
    await expect(s.ask('extract', 1, 'source', (a) => a, [], { registry: [] })).resolves.toBe('ok')
    expect(s.delay).toHaveBeenCalledWith(2000, s.controller.signal)
    expect(s.store.extraction(s.job.id).calls.map((c) => c.part)).toEqual([1, 2])
    for (const part of [1, 2])
      expect(s.store.part(s.job.id, `input:extract:${part}`, inputHash('source'))).toBeDefined()
    expect(s.store.job(s.job.id)!.usage).toEqual({ tokens: 15, cost: 0.30000000000000004 })
  },
)
it('fails after two provider failures', async () => {
  const s = await setup()
  s.runner.mockImplementation(async (input) => {
    input.onTrace?.(failure('error'))
    throw new Error('Socket closed')
  })
  await expect(s.ask('extract', 1, 'source', (a) => a)).rejects.toThrow('Socket closed')
  expect(s.runner).toHaveBeenCalledTimes(2)
  expect(s.store.extraction(s.job.id).calls).toHaveLength(2)
  expect(s.store.job(s.job.id)!.usage?.tokens).toBe(10)
})
it.each(['aborted', 'timeout'] as const)('does not retry %s', async (reason) => {
  const s = await setup()
  s.runner.mockImplementation(async (input) => {
    input.onTrace?.(failure(reason))
    throw new Error(reason)
  })
  await expect(s.ask('extract', 1, 'source', (a) => a)).rejects.toThrow(reason)
  expect(s.runner).toHaveBeenCalledOnce()
  expect(s.delay).not.toHaveBeenCalled()
})
it('stops before another attempt when aborted during the delay', async () => {
  const s = await setup()
  s.runner.mockImplementation(async (input) => {
    input.onTrace?.(failure('error'))
    throw new Error('Socket closed')
  })
  s.delay.mockImplementation(async () => {
    s.controller.abort()
  })
  await expect(s.ask('extract', 1, 'source', (a) => a)).rejects.toThrow()
  expect(s.delay).toHaveBeenCalledOnce()
  expect(s.runner).toHaveBeenCalledOnce()
})
it('checkpoints a whole part with 600 segment references', async () => {
  const s = await setup()
  const segments = Array.from({ length: 600 }, (_, i) => ({
    entryId: `made-up-${i}-${'a'.repeat(80)}`,
    index: i,
    start: 0,
    end: 400,
  }))
  await s.ask('extract', 1, 'source', (a) => a, [], { segments })
  const saved = s.store.part(s.job.id, 'input:extract:1', inputHash('source'))
  expect(saved).toBeDefined()
  expect(JSON.parse(saved!.output)).toEqual({ segments })
})
