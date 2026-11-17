import { afterEach, expect, it, vi } from 'vitest'
import type { BrainTidyPair, BrainTidyRun, BrainTidyJudgement } from '@phosphor/shared/brain-tidy'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { emptyBrainTidyCoverage } from '@phosphor/shared/brain-tidy'
import { FakeBrainStore, FakeBrainSearch, HARBOR_JOB } from '../__fixtures__/fake-store'
import { recallOptions } from '../__fixtures__/options'
import type { ModelCallInput } from '../model-call'
import { CallTracer } from '../call-trace'
import { ExtractionQueue } from '../queue'
import { createTidyRunner } from './run'
import { NO_MODEL } from './check'

const queues: ExtractionQueue[] = []
afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.dispose()
})
function pair(index: number): BrainTidyPair {
  const card = (id: string) => ({
    type: 'memory' as const,
    id,
    sentence: 'Harbor bills weekly.',
    memoryType: 'fact' as const,
    scope: 'Harbor',
    branch: null,
    validFrom: null,
    validTo: null,
    observedAt: 1,
    entities: ['Harbor'],
    quotes: ['Harbor bills weekly.'],
  })
  return { suggestionId: `pair-${index}`, subjects: [card(`a-${index}`), card(`b-${index}`)] }
}
async function answer(input: ModelCallInput) {
  const refs = [...input.prompt.matchAll(/"ref":"(P\d+)"/g)].slice(1)
  return {
    text: JSON.stringify({
      decisions: refs.map((m, i) => ({
        ref: m[1],
        verdict: ['same', 'different', 'conflict', 'replaces'][i % 4],
        ...(i % 4 === 3 ? { newer: 'b' } : {}),
        reason: 'Supported by the supplied evidence.',
      })),
    }),
    usage: { tokens: 10, cost: 1 },
  }
}
function setup(count = 8, finished = true) {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch()
  store.prefs.enabled = true
  if (finished) {
    const job = store.enqueue(HARBOR_JOB, 'queued')
    store.updateJob(job.id, { state: 'done', finishedAt: 1 })
  }
  const pending = Array.from({ length: count }, (_, i) => pair(i))
  const recorded: BrainTidyJudgement[] = []
  /** Pairs the owner answers while the model reads them. */
  const settled = new Set<string>()
  const pendingPairs = vi
    .spyOn(store as BrainStore, 'pendingPairs')
    .mockImplementation(() => pending)
  vi.spyOn(store as BrainStore, 'recordVerdicts').mockImplementation((rows) => {
    const open = rows.filter((row) => !settled.has(row.suggestionId))
    recorded.push(...open)
    const answered = new Set(rows.map((row) => row.suggestionId))
    pending.splice(0, pending.length, ...pending.filter((p) => !answered.has(p.suggestionId)))
    return { recorded: open.length, settled: rows.length - open.length }
  })
  const sweep = vi.spyOn(store as BrainStore, 'sweep').mockReturnValue({
    coverage: { ...emptyBrainTidyCoverage(), phase: 'done' },
    suggestions: 2,
    folded: 1,
    operationIds: ['fold'],
  })
  const apply = vi.spyOn(store, 'tidyApply')
  const calls = vi.fn(answer)
  const options = {
    ...recallOptions(store),
    runModelCall: calls,
    retryDelay: vi.fn(async () => {}),
  }
  const queue = new ExtractionQueue({
    store,
    busy: () => false,
    ready: () => true,
    now: () => 100,
    run: async () => {},
    changed: () => {},
  })
  queues.push(queue)
  let persisted: BrainTidyRun | null = null
  const states: BrainTidyRun[] = []
  const runState = {
    readRun: () => persisted,
    writeRun: (run: BrainTidyRun) => {
      persisted = structuredClone(run)
      states.push(persisted)
    },
  }
  const context = { store, search, options, queue, changed: () => {}, runState }
  const runner = createTidyRunner(context)
  const finish = async () => {
    await vi.waitFor(() =>
      expect(['done', 'failed', 'cancelled', 'skipped', 'interrupted']).toContain(
        runner.current()?.state,
      ),
    )
    return runner.current()!
  }
  return {
    context,
    runner,
    finish,
    pending,
    pendingPairs,
    recorded,
    settled,
    sweep,
    apply,
    calls,
    states,
    options,
    store,
    search,
  }
}
it('checks eight pairs with the pinned reader, records exact model and never applies', async () => {
  const s = setup()
  s.store.prefs.model = 'example/pinned'
  s.runner.start()
  expect(await s.finish()).toMatchObject({
    state: 'done',
    checked: 8,
    total: 8,
    folded: 1,
    suggestions: 2,
  })
  expect(s.calls).toHaveBeenCalledOnce()
  expect(s.calls.mock.calls[0]![0]).toMatchObject({
    stage: 'tidy',
    thinking: 'medium',
    lane: { model: 'example/pinned' },
  })
  expect(s.recorded.map((j) => j.verdict.kind)).toEqual([
    'same',
    'different',
    'conflict',
    'replaces',
    'same',
    'different',
    'conflict',
    'replaces',
  ])
  expect(s.recorded.every((j) => j.model === 'example/pinned')).toBe(true)
  expect(s.recorded[3]?.verdict).toMatchObject({ newerId: 'b-3' })
  expect(s.apply).not.toHaveBeenCalled()
  expect(s.search.refreshes).toBe(1)
  expect(JSON.stringify(s.states)).not.toMatch(/tokens|cost/)
})
it('counts only recorded verdicts, says what the owner settled and records the model', async () => {
  const s = setup(12)
  s.settled.add('pair-3')
  s.runner.start()
  expect(await s.finish()).toMatchObject({
    state: 'done',
    checked: 11,
    settled: 1,
    total: 12,
    model: HARBOR_JOB.model,
    message: 'Checked 11 pairs; you settled 1 while it ran.',
  })
})
it('uses the newest launchable finished read, without an empty session path', async () => {
  const s = setup()
  const newer = s.store.enqueue(
    {
      ...HARBOR_JOB,
      sessionId: 'ledger',
      sessionPath: '/made-up/gone.jsonl',
      model: 'example/newest',
    },
    'queued',
  )
  s.store.updateJob(newer.id, { state: 'done', finishedAt: 2 })
  const launch = vi.spyOn(s.options.lanes, 'launch').mockRejectedValueOnce(new Error('gone'))
  s.runner.start()
  await s.finish()
  expect(launch.mock.calls.map(([path]) => path)).toEqual([
    '/made-up/gone.jsonl',
    HARBOR_JOB.sessionPath,
  ])
  expect(s.recorded[0]?.model).toBe(HARBOR_JOB.model)
})
it.each([null, 'example/pinned'])(
  'still sweeps without finished reads (pinned %s)',
  async (model) => {
    const s = setup(8, false)
    s.store.prefs.model = model
    s.runner.start()
    expect(await s.finish()).toMatchObject({ state: 'skipped', message: NO_MODEL })
    expect(s.sweep).toHaveBeenCalledWith('all')
    expect(s.calls).not.toHaveBeenCalled()
  },
)
it('bounds the click at forty, cancels between calls and persists progress across restart', async () => {
  const s = setup(50)
  const record = s.context.store.recordVerdicts.bind(s.context.store)
  s.context.store.recordVerdicts = (...args: unknown[]) => {
    const result = record(...(args as []))
    s.runner.cancel()
    return result
  }
  s.runner.start()
  expect(await s.finish()).toMatchObject({ state: 'cancelled', checked: 8, total: 40 })
  expect(s.calls).toHaveBeenCalledOnce()
  expect(s.pendingPairs).toHaveBeenCalledWith(40)
  expect(createTidyRunner(s.context).current()).toMatchObject({ checked: 8 })
  s.context.runState.writeRun({ ...s.runner.current()!, state: 'checking' })
  expect(createTidyRunner(s.context).current()).toMatchObject({
    state: 'interrupted',
    checked: 8,
    error: expect.stringContaining('interrupted'),
  })
})
it.each(['error', 'timeout'] as const)(
  'handles %s, retries only transport failure and continues later batches',
  async (reason) => {
    const s = setup(16)
    const fail = async (input: ModelCallInput): Promise<never> => {
      const tracer = new CallTracer()
      tracer.finish(reason)
      input.onTrace?.(tracer.trace)
      throw new Error(`Harbor ${reason}`)
    }
    s.calls.mockImplementationOnce(fail)
    if (reason === 'error') s.calls.mockImplementationOnce(fail)
    s.runner.start()
    expect(await s.finish()).toMatchObject({
      state: 'failed',
      checked: 8,
      error: expect.stringContaining(`Harbor ${reason}`),
    })
    expect(s.calls).toHaveBeenCalledTimes(reason === 'error' ? 3 : 2)
    expect(s.options.retryDelay).toHaveBeenCalledTimes(reason === 'error' ? 1 : 0)
    expect(s.pending).toHaveLength(8)
  },
)
it('drops malformed items and unknown handles, leaves missing pairs for Retry', async () => {
  const s = setup()
  s.calls.mockResolvedValueOnce({
    text: JSON.stringify({
      decisions: [
        { ref: 'P1', verdict: 'same', reason: 'Same assertion.' },
        { ref: 'P2', verdict: 'replaces', newer: 'unknown', reason: 'Newer.' },
        { ref: 'P99', verdict: 'same', reason: 'Unknown.' },
      ],
    }),
    usage: { tokens: 0, cost: 0 },
  })
  s.runner.start()
  expect(await s.finish()).toMatchObject({
    state: 'failed',
    checked: 1,
    message: expect.stringContaining('Dropped 2'),
  })
  expect(s.recorded).toHaveLength(1)
  expect(s.pending).toHaveLength(7)
})
it('unusable JSON leaves a batch unjudged without a model repair or automatic retry', async () => {
  const s = setup()
  s.calls.mockResolvedValueOnce({ text: 'not JSON', usage: { tokens: 0, cost: 0 } })
  s.runner.start()
  expect(await s.finish()).toMatchObject({
    state: 'failed',
    checked: 0,
    error: expect.stringContaining('Retry'),
  })
  expect(s.calls).toHaveBeenCalledOnce()
})

it('does not retain a run after Reset removes the persisted singleton', async () => {
  const s = setup()
  s.runner.start()
  await s.finish()
  vi.spyOn(s.context.runState, 'readRun').mockReturnValue(null)
  expect(s.runner.current()).toBeNull()
})

it('Retry recovers a failed first load and calls only still-unjudged pairs', async () => {
  const s = setup(16)
  s.calls.mockRejectedValueOnce(new Error('Reader unavailable'))
  s.runner.start()
  expect(await s.finish()).toMatchObject({ state: 'failed', checked: 8 })
  expect(s.pending).toHaveLength(8)
  s.runner.start()
  expect(await s.finish()).toMatchObject({ state: 'done', checked: 8, total: 8, error: null })
  expect(s.pending).toHaveLength(0)
  expect(s.recorded).toHaveLength(16)
  expect(new Set(s.recorded.map((j) => j.suggestionId)).size).toBe(16)
})

it('transport retry recovers in the same batch without persisting usage', async () => {
  const s = setup()
  s.calls.mockImplementationOnce(async (input) => {
    const tracer = new CallTracer()
    tracer.finish('exit')
    input.onTrace?.(tracer.trace)
    throw new Error('Reader exited')
  })
  s.runner.start()
  expect(await s.finish()).toMatchObject({ state: 'done', checked: 8, error: null })
  expect(s.calls).toHaveBeenCalledTimes(2)
  expect(s.options.retryDelay).toHaveBeenCalledOnce()
  expect(JSON.stringify(s.states)).not.toMatch(/tokens|cost/)
})

it('advances local sweep chunks before the first model call and stops at the coverage end', async () => {
  const s = setup()
  s.sweep.mockReturnValueOnce({
    coverage: emptyBrainTidyCoverage(),
    suggestions: 1,
    folded: 0,
    operationIds: [],
  })
  s.runner.start()
  await s.finish()
  expect(s.sweep).toHaveBeenCalledTimes(2)
  expect(s.sweep.mock.invocationCallOrder[1]).toBeLessThan(s.calls.mock.invocationCallOrder[0]!)
  expect(s.runner.current()).toMatchObject({ suggestions: 3, folded: 1 })
})

it('ends the local pass at its time bound even when coverage is not complete', async () => {
  const s = setup(0)
  let tick = 0
  s.options.now = () => (tick++ ? 3000 : 0)
  s.sweep.mockReturnValue({
    coverage: emptyBrainTidyCoverage(),
    suggestions: 0,
    folded: 0,
    operationIds: [],
  })
  s.runner.start()
  expect(await s.finish()).toMatchObject({ state: 'done', total: 0 })
  expect(s.sweep).toHaveBeenCalledOnce()
  expect(s.calls).not.toHaveBeenCalled()
})

it('records an explicit skipped state when no lane can supply a reader', async () => {
  const s = setup(8, false)
  s.runner.start()
  await vi.waitFor(() => expect(s.runner.current()?.finishedAt).not.toBeNull())
  expect(s.runner.current()?.state).toBe('skipped')
  expect(s.runner.current()?.message).toBe(NO_MODEL)
})
