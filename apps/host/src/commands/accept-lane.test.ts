import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLifecycle } from '../session/lifecycle'
import { ACCEPT_TIMINGS, type AcceptContext } from './accept'
import { createAcceptLaneState, laneRequest, runLane, type AcceptLaneState } from './accept-lane'
import * as steps from './accept-steps'

function setup(overrides: Partial<AcceptContext> = {}) {
  const context: AcceptContext = {
    configPath: '/config',
    env: {},
    platform: 'linux',
    uid: 1000,
    home: '/home',
    hostname: 'host',
    nodeVersion: process.version,
    defaultResourceRoot: '/resources',
    repository: '/repo',
    lane: 'native',
    keepTranscripts: false,
    progress: vi.fn(),
    ...overrides,
  }
  const runtime = {
    start: vi.fn<AcceptLaneState['runtime']['start']>(),
    command: vi.fn<AcceptLaneState['runtime']['command']>(),
    stop: vi.fn<AcceptLaneState['runtime']['stop']>().mockResolvedValue(),
    remove: vi.fn<AcceptLaneState['runtime']['remove']>(),
    life: createLifecycle(() => {}),
  }
  const options = { timings: ACCEPT_TIMINGS, settleMs: 0, progress: context.progress }
  return { context, runtime, options }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('accept lane', () => {
  it('creates independent session ownership, event history, result and token for each lane', () => {
    const { context, runtime, options } = setup({ provider: 'native', model: 'model' })
    const native = createAcceptLaneState(runtime, 'native', context, options)
    const claude = createAcceptLaneState(runtime, 'claude', context, options)
    expect(native.session).toBeNull()
    expect(native.token).toMatch(/^PHX-[0-9a-f]{8}$/)
    expect(native.token).not.toBe(claude.token)
    native.watch.deliver({ kind: 'resync' })
    native.result.steps.push({ name: 'start', ok: true, ms: 0 })
    expect(claude.watch.mark()).toBe(0)
    expect(claude.result.steps).toEqual([])
    expect(native.request).toEqual({ repository: '/repo', provider: 'native', model: 'model' })
    expect(claude.request).toEqual({ repository: '/repo' })
    expect(laneRequest('claude', { ...context, claudeModel: 'sonnet' })).toEqual({
      repository: '/repo',
      provider: 'pi-claude-cli',
      model: 'sonnet',
    })
  })

  it('sequences named steps and relinquishes session ownership before successful cleanup', async () => {
    const { context, runtime, options } = setup()
    const order: string[] = []
    for (const name of [
      'startStep',
      'stateStep',
      'promptStep',
      'abortStep',
      'stop',
      'resumeStep',
      'closeStep',
    ] as const) {
      vi.spyOn(steps, name).mockImplementation(async (state) => {
        order.push(name)
        state.session = name === 'closeStep' ? null : { sessionId: name }
      })
    }
    const result = await runLane(runtime, 'native', context, options)
    expect(order).toEqual([
      'startStep',
      'stateStep',
      'promptStep',
      'abortStep',
      'stop',
      'resumeStep',
      'closeStep',
    ])
    expect(result.verdict).toBe('pass')
    expect(result.steps.map(({ name, ok }) => [name, ok])).toEqual(
      ['start', 'state', 'prompt', 'abort', 'dispose', 'resume', 'close'].map((name) => [
        name,
        true,
      ]),
    )
    expect(runtime.stop).not.toHaveBeenCalled()
  })

  it('short-circuits a failed step, stops its owned session and keeps the transcript', async () => {
    const { context, runtime, options } = setup()
    vi.spyOn(steps, 'startStep').mockImplementation(async (state) => {
      state.session = { sessionId: 'owned' }
      state.result.transcript = '/kept.jsonl'
    })
    vi.spyOn(steps, 'stateStep').mockRejectedValue(new Error('bad state'))
    const prompt = vi.spyOn(steps, 'promptStep')
    const result = await runLane(runtime, 'native', context, options)
    expect(result).toMatchObject({
      verdict: 'fail',
      transcript: '/kept.jsonl',
      transcriptDeleted: false,
      steps: [
        { name: 'start', ok: true },
        { name: 'state', ok: false, detail: 'bad state' },
      ],
    })
    expect(prompt).not.toHaveBeenCalled()
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith('owned')
    expect(runtime.remove).not.toHaveBeenCalled()
  })

  it('leaves a draining session to the signal drain instead of stopping it twice', async () => {
    const { context, runtime, options } = setup()
    vi.spyOn(steps, 'startStep').mockImplementation(async (state) => {
      state.session = { sessionId: 'owned' }
      runtime.life.to('draining')
      throw new Error('signal')
    })
    const result = await runLane(runtime, 'native', context, options)
    expect(result.verdict).toBe('fail')
    expect(runtime.stop).not.toHaveBeenCalled()
  })

  it('records cleanup timeout separately after a failed step', async () => {
    vi.useFakeTimers()
    const { context, runtime, options } = setup()
    vi.spyOn(steps, 'startStep').mockImplementation(async (state) => {
      state.session = { sessionId: 'owned' }
      throw new Error('bad start')
    })
    runtime.stop.mockReturnValue(new Promise(() => {}))
    const pending = runLane(runtime, 'native', context, {
      ...options,
      timings: { ...ACCEPT_TIMINGS, stopMs: 10 },
    })
    await vi.advanceTimersByTimeAsync(10)
    expect((await pending).steps).toMatchObject([
      { name: 'start', ok: false, detail: 'bad start' },
      { name: 'stop', ok: false, detail: 'no end to the stop within 10 ms', cleanup: true },
    ])
    expect(vi.getTimerCount()).toBe(0)
  })
})
