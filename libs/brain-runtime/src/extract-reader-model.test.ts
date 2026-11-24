import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from '@phosphor/memory-engine/test-support'
import type { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import { extractJob } from './extract'
import { runModelCall } from './model-call'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'

async function setup(model: string | null, thinking: string) {
  const s = await pipelineSetup()
  afterEach(s.cleanup)
  const { store } = fixture()
  store.setPrefs({
    neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
    enabled: true,
    recall: true,
    agentAuto: true,
    model,
  })
  await writeFile(
    s.file,
    [...s.entries, { type: 'thinking_level_change', thinkingLevel: thinking }]
      .map((e) => JSON.stringify(e))
      .join('\n'),
  )
  const job = store.enqueue(s.job, 'queued')
  const transport = vi
    .fn<typeof runPrintMode>()
    .mockImplementation(async (_binary, _args, options) => {
      options.onStdout?.(
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: '{"entities":[],"claims":[]}' }],
          },
        }) + '\n',
      )
      return { stdout: '' }
    })
  const launch = vi.spyOn(s.options.lanes, 'launch')
  const options = {
    ...s.options,
    runModelCall: (input: Parameters<typeof runModelCall>[0]) => runModelCall(input, transport),
  }
  const run = () =>
    extractJob(
      store.updateJob(job.id, { state: 'running' }),
      new AbortController().signal,
      store,
      options,
      s.search,
    )
  return { ...s, store, job, transport, launch, run }
}

it.each(['off', 'low'])(
  'freezes the reader model and medium thinking over lane %s in job, argv and extraction',
  async (thinking) => {
    const s = await setup('claude-cli/harbor-reader', thinking)
    await s.run()
    expect(s.store.job(s.job.id)?.model).toBe('claude-cli/harbor-reader')
    const args = s.transport.mock.calls[0]![1]
    expect(args[args.indexOf('--model') + 1]).toBe('claude-cli/harbor-reader')
    expect(args[args.indexOf('--thinking') + 1]).toBe('medium')
    expect(s.store.extraction(s.job.id)).toMatchObject({
      model: 'claude-cli/harbor-reader',
      thinking: 'medium',
    })
    expect(s.launch).toHaveBeenCalledWith(s.file)
    // No lane Claude account: launch adds no credential override, so the provider uses its default.
    expect(s.transport.mock.calls[0]![2].env).not.toHaveProperty('CLAUDE_SECURESTORAGE_CONFIG_DIR')
  },
)

it.each([
  ['off', 'off'],
  ['low', 'low'],
  ['high', 'medium'],
  ['max', 'medium'],
])(
  'without a reader preference uses the lane model and caps %s at %s',
  async (thinking, expected) => {
    const s = await setup(null, thinking!)
    await s.run()
    expect(s.store.job(s.job.id)?.model).toBe('example/fast')
    const args = s.transport.mock.calls[0]![1]
    expect(args[args.indexOf('--model') + 1]).toBe('example/fast')
    expect(args[args.indexOf('--thinking') + 1]).toBe(expected)
  },
)

it('keeps a started job frozen across preference changes, restart and Retry', async () => {
  const s = await setup('harbor/reader', 'off')
  s.transport.mockResolvedValueOnce({ stdout: '', reason: 'timeout' })
  await expect(s.run()).rejects.toThrow('Timed out')
  s.store.setPrefs({ ...s.store.snapshot().prefs, model: 'ledger/other' })
  s.store.updateJob(s.job.id, { state: 'failed' })
  s.store.retry(s.job.id)
  await s.run()
  expect(s.store.job(s.job.id)?.model).toBe('harbor/reader')
  expect(s.store.extraction(s.job.id)).toMatchObject({ model: 'harbor/reader', thinking: 'medium' })
  expect(
    s.transport.mock.calls.every(
      ([, args]) => args[args.indexOf('--model') + 1] === 'harbor/reader',
    ),
  ).toBe(true)
})

it('queues and reads a lane without a model when the reader preference is set', async () => {
  const s = await setup('harbor/reader', 'off')
  await writeFile(
    s.file,
    s.entries
      .filter((e) => e.type === 'session' || e.message?.role === 'user')
      .map((e) => JSON.stringify(e))
      .join('\n'),
  )
  s.store.removeJob(s.job.id)
  const service = await createBrainService({ ...s.options, openStore: () => s.store })
  afterEach(() => service.dispose())
  await expect(service.api.queue({ sessionPath: s.file, title: 'Harbor' })).resolves.toHaveProperty(
    'jobs',
  )
  await vi.waitFor(() => expect(s.runner).toHaveBeenCalled())
  expect(s.runner.mock.calls[0]![0].lane.model).toBe('harbor/reader')
})

it('chooses the preference at first start, not when the lane was queued', async () => {
  const s = await setup(null, 'low')
  s.store.setPrefs({ ...s.store.snapshot().prefs, model: 'harbor/start-reader' })
  await s.run()
  expect(s.store.job(s.job.id)?.model).toBe('harbor/start-reader')
  expect(s.store.extraction(s.job.id)).toMatchObject({
    model: 'harbor/start-reader',
    thinking: 'medium',
  })
})
