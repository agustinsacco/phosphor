import { afterEach, expect, it, vi } from 'vitest'
import { runModelCall } from './model-call'
import type { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
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
  // Each Retry builds a fresh caller and record over the same job and store.
  const caller = async () =>
    stageCaller({
      job: s.job,
      lane: await readLane(s.file),
      store: s.store,
      options,
      signal: controller.signal,
      record: new ExtractionRecord(s.job, s.store, Date.now, 'medium'),
    })
  return { ...s, controller, delay, ask: await caller(), caller }
}
function failure(reason: 'error' | 'no-text' | 'aborted' | 'timeout' | 'overflow') {
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
it.each(['aborted', 'timeout', 'overflow'] as const)('does not retry %s', async (reason) => {
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

it.each(['exit', 'spawn'] as const)(
  'retries a process %s and preserves its diagnostic trace reason',
  async (reason) => {
    const s = await setup()
    const transport = vi
      .fn<typeof runPrintMode>()
      .mockImplementationOnce(async (_binary, _args, options) => {
        if (reason === 'exit')
          options.onStdout?.(
            JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                stopReason: 'error',
                errorMessage: 'Fake dropped socket',
                content: [],
                usage: { totalTokens: 5 },
              },
            }) + '\n',
          )
        return { stdout: '', reason, error: `Fake process ${reason}` }
      })
      .mockImplementationOnce(async (_binary, _args, options) => {
        options.onStdout?.(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'stop',
              content: [{ type: 'text', text: '{}' }],
              usage: { totalTokens: 10 },
            },
          }) + '\n',
        )
        return { stdout: '' }
      })
    s.runner.mockImplementation((input) => runModelCall(input, transport))
    await expect(s.ask('extract', 1, 'source', (a) => a)).resolves.toBe('{}')
    expect(transport).toHaveBeenCalledTimes(2)
    const calls = s.store.extraction(s.job.id).calls
    expect(calls.map((c) => c.trace?.reason)).toEqual([reason, 'completed'])
    if (reason === 'exit')
      expect(calls[0]!.trace).toMatchObject({
        stopReason: 'error',
        providerError: 'Fake dropped socket',
      })
  },
)

it.each(['identity', 'reconcile'] as const)(
  'answers a repeated %s prompt after Retry from its accepted answer, without a new call',
  async (stage) => {
    const s = await setup()
    s.runner
      .mockResolvedValueOnce({ text: 'first', usage: { tokens: 10, cost: 0.2 } })
      .mockResolvedValue({ text: 'second', usage: { tokens: 10, cost: 0.2 } })
    await expect(s.ask(stage, 1, 'rows 1 and 2', (a) => a)).resolves.toBe('first')
    const retry = await s.caller()
    await expect(retry(stage, 1, 'rows 1 and 2', (a) => a)).resolves.toBe('first')
    expect(s.runner).toHaveBeenCalledOnce()
    // Only the rows the accepted answer left undecided reach the model again.
    await expect(retry(stage, 1, 'row 2', (a) => a)).resolves.toBe('second')
    expect(s.runner).toHaveBeenCalledTimes(2)
    expect(s.store.extraction(s.job.id).calls.map((c) => c.part)).toEqual([1, 2])
  },
)
it('keeps the repaired answer for a repeated prompt, never the rejected one', async () => {
  const s = await setup()
  const valid = (a: string) => {
    if (a !== 'good') throw new Error('Invalid answer')
    return a
  }
  s.runner
    .mockResolvedValueOnce({ text: 'bad', usage: { tokens: 10, cost: 0.2 } })
    .mockResolvedValueOnce({ text: 'good', usage: { tokens: 10, cost: 0.2 } })
    .mockResolvedValue({ text: 'bad', usage: { tokens: 10, cost: 0.2 } })
  await expect(s.ask('reconcile', 1, 'rows', valid)).resolves.toBe('good')
  await expect((await s.caller())('reconcile', 1, 'rows', valid)).resolves.toBe('good')
  expect(s.runner).toHaveBeenCalledTimes(2)
})
it('asks again when no answer to the prompt was ever accepted', async () => {
  const s = await setup()
  const invalid = () => {
    throw new Error('Invalid answer')
  }
  s.runner.mockResolvedValue({ text: 'bad', usage: { tokens: 10, cost: 0.2 } })
  await expect(s.ask('identity', 1, 'rows', invalid)).rejects.toThrow('after repair')
  await expect((await s.caller())('identity', 1, 'rows', (a) => a)).resolves.toBe('bad')
  expect(s.runner).toHaveBeenCalledTimes(3)
})
