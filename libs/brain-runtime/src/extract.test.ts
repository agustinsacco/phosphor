import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { extractJob } from './extract'
import { runFork } from './fork'
import { ForkTracer } from './fork-trace'
import { FakeBrainStore, HARBOR_JOB } from './__fixtures__/fake-store'
import { LANE_ENTRIES, RAW_EXTRACTION } from './__fixtures__/lane'
import { recallOptions } from './__fixtures__/options'

vi.mock('./fork', () => ({ runFork: vi.fn() }))
const directories: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-extract-'))
  directories.push(directory)
  const file = join(directory, 'harbor.jsonl')
  await writeFile(file, LANE_ENTRIES.map((entry) => JSON.stringify(entry)).join('\n'))
  const store = new FakeBrainStore()
  const job = store.enqueue({ ...HARBOR_JOB, sessionPath: file }, 'queued')
  const options = { ...recallOptions(store), directory, log: vi.fn() }
  const tracer = new ForkTracer(() => 0)
  tracer.finish('completed')
  vi.mocked(runFork).mockImplementation(async (input) => {
    input.onTrace?.(tracer.trace, 'scrubbed Harbor warning')
    return { text: JSON.stringify(RAW_EXTRACTION), usage: { tokens: 90, cost: 0.001 } }
  })
  const controller = new AbortController()
  const run = () => extractJob(job, controller.signal, store, options)
  return { store, job, options, controller, run, tracer, file }
}

it('logs the successful lifecycle with metadata and trace, but no stderr or answer content', async () => {
  const s = await setup()
  await s.run()
  expect(s.options.log.mock.calls.map(([message]) => message)).toEqual([
    'Brain extraction started',
    'Brain extraction fork finished',
    'Brain extraction parsed',
    'Brain extraction quotes verified',
    'Brain extraction embedded',
    'Brain extraction proposed',
    'Brain extraction finished',
  ])
  for (const [, data] of s.options.log.mock.calls) {
    expect(data).toMatchObject({
      jobId: s.job.id,
      model: 'example/fast',
      thinking: 'low',
      laneBytes: (await stat(s.file)).size,
      totalMs: expect.any(Number),
    })
    expect(data).not.toHaveProperty('stderr')
  }
  expect(s.options.log).toHaveBeenLastCalledWith(
    'Brain extraction finished',
    expect.objectContaining({
      trace: s.tracer.trace,
      forkMs: 0,
      kept: 1,
      duplicates: 0,
      dropped: 0,
    }),
  )
  expect(JSON.stringify(s.options.log.mock.calls)).not.toMatch(
    /Rina Okafor|scrubbed Harbor warning/,
  )
})

it.each(['launch', 'parse', 'quote', 'embed', 'propose', 'review'])(
  'logs exactly one scrubbed failure in phase %s without answer text',
  async (phase) => {
    const s = await setup()
    const failure = new Error('Harbor unavailable token=harbor-secret')
    if (phase === 'launch') vi.spyOn(s.options.lanes, 'launch').mockRejectedValue(failure)
    if (phase === 'parse')
      vi.mocked(runFork).mockResolvedValue({
        text: 'private answer',
        usage: { tokens: 0, cost: 0 },
      })
    if (phase === 'quote')
      vi.mocked(runFork).mockImplementation(async (input) => {
        input.onTrace?.(s.tracer.trace)
        await rm(s.file)
        return { text: JSON.stringify(RAW_EXTRACTION), usage: { tokens: 0, cost: 0 } }
      })
    if (phase === 'embed') vi.spyOn(s.options.embeddings, 'embed').mockRejectedValue(failure)
    if (phase === 'propose')
      vi.spyOn(s.store, 'propose').mockImplementation(() => {
        throw failure
      })
    if (phase === 'review') {
      s.store.prefs.review = false
      vi.spyOn(s.store, 'review').mockImplementation(() => {
        throw failure
      })
    }
    await expect(s.run()).rejects.toThrow()
    const failures = s.options.log.mock.calls.filter(
      ([message]) => message === 'Brain extraction failed',
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]![1]).toMatchObject({ jobId: s.job.id, phase, reason: 'error' })
    expect(JSON.stringify(s.options.log.mock.calls)).not.toMatch(
      /harbor-secret|private answer|Rina Okafor/,
    )
    expect(s.options.log.mock.calls.map(([message]) => message)).not.toContain(
      'Brain extraction finished',
    )
  },
)

it('logs a fork timeout once with trace and failure-only stderr', async () => {
  const s = await setup()
  s.tracer.event({
    type: 'auto_retry_start',
    attempt: 1,
    delayMs: 2000,
    errorMessage: '429 token=harbor-secret',
  })
  s.tracer.finish('timeout')
  const message = s.tracer.timeoutMessage('example/fast')
  vi.mocked(runFork).mockImplementation(async (input) => {
    input.onTrace?.(s.tracer.trace, '[redacted]')
    throw new Error(message)
  })
  await expect(s.run()).rejects.toThrow(message)
  const failures = s.options.log.mock.calls.filter(([name]) => name === 'Brain extraction failed')
  expect(failures).toEqual([
    [
      'Brain extraction failed',
      expect.objectContaining({
        phase: 'fork',
        reason: 'timeout',
        trace: s.tracer.trace,
        error: message,
        stderr: '[redacted]',
      }),
    ],
  ])
  expect(JSON.stringify(s.options.log.mock.calls)).not.toContain('harbor-secret')
  expect(
    s.options.log.mock.calls.filter(([name]) => name === 'Brain extraction fork finished'),
  ).toHaveLength(1)
})

it('logs cancellation before preparation and during embedding without creating a proposal', async () => {
  const before = await setup()
  before.controller.abort()
  await expect(before.run()).rejects.toThrow('Knowledge extraction aborted.')
  expect(runFork).not.toHaveBeenCalled()
  expect(before.options.log).toHaveBeenCalledExactlyOnceWith(
    'Brain extraction failed',
    expect.objectContaining({
      phase: 'lane',
      reason: 'aborted',
      trace: null,
      laneBytes: null,
    }),
  )
  const during = await setup()
  vi.spyOn(during.options.embeddings, 'embed').mockImplementation(async () => {
    during.controller.abort()
    during.store.removeJob(during.job.id)
    return [[1, 0]]
  })
  await expect(during.run()).rejects.toThrow('Knowledge extraction aborted.')
  expect(during.store.proposals.size).toBe(0)
  const failures = during.options.log.mock.calls.filter(
    ([name]) => name === 'Brain extraction failed',
  )
  expect(failures).toHaveLength(1)
  expect(failures[0]![1]).toMatchObject({
    phase: 'embed',
    reason: 'aborted',
    trace: during.tracer.trace,
  })
})
