import { describe, expect, it, vi } from 'vitest'
import { emptyBrainTidyCoverage } from '@phosphor/shared/brain-tidy'
import type { BrainAgentHost, BrainAgentTurn } from '../types'
import { ExtractionQueue } from '../queue'
import { FakeAgentStore } from '../__fixtures__/fake-agent-store'
import { FakeBrainSearch, HARBOR_JOB } from '../__fixtures__/fake-store'
import { createDefrag, defragMessage } from './defrag'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const finished: BrainAgentTurn = {
  outcome: 'finished',
  error: null,
  sessionPath: '/brain/Brain/lane.jsonl',
  rulesChanged: false,
}

function setup(turn?: BrainAgentHost['turn']) {
  const store = new FakeAgentStore()
  store.prefs.enabled = true
  store.counts = { groups: 1, unlinked: 0, entities: 0, repeats: 2, conflicts: 0, flags: 0 }
  const search = new FakeBrainSearch()
  const runs: { id: string; finish(): void }[] = []
  const queue = new ExtractionQueue({
    store,
    busy: () => false,
    ready: () => true,
    changed: () => {},
    now: () => 123,
    run: (job) =>
      new Promise<void>((resolve) => {
        runs.push({
          id: job.id,
          finish: () => {
            store.updateJob(job.id, { state: 'done' })
            resolve()
          },
        })
      }),
  })
  const host: BrainAgentHost = {
    folder: '/brain/Brain',
    tell: vi.fn(),
    turn: vi.fn(
      turn ??
        (async (_message, _signal, hooks) => {
          hooks.opened('/brain/Brain/lane.jsonl')
          hooks.sending()
          return finished
        }),
    ),
  }
  const changed = vi.fn()
  const runEnded = vi.fn()
  const defrag = createDefrag({
    runEnded,
    store,
    search,
    options: { agent: host, now: () => 500 },
    queue,
    changed,
  })
  return { store, search, queue, host, defrag, changed, runs, runEnded }
}

describe('defragMessage', () => {
  it('counts each kind in the header order, leaving out zero kinds', () => {
    expect(
      defragMessage(
        { groups: 2, unlinked: 4, entities: 10, repeats: 13, conflicts: 1, flags: 1 },
        false,
      ),
    ).toBe(
      'Defrag. 31 waiting: 10 people and things, 2 groups, 4 unlinked pairs, 13 repeats, 1 disagreement, 1 flag. Start with brain_waiting.',
    )
    expect(
      defragMessage(
        { groups: 0, unlinked: 0, entities: 1, repeats: 0, conflicts: 2, flags: 0 },
        true,
      ),
    ).toBe(
      'Defrag. 3 waiting: 1 person or thing, 2 disagreements, and up to 40 possible repeats. Start with brain_waiting.',
    )
  })
})

describe('createDefrag', () => {
  it('refuses with plain sentences', async () => {
    const s = setup()
    s.store.prefs.enabled = false
    expect(() => s.defrag.start()).toThrow('Turn on Brain before running Defrag.')
    s.store.prefs.enabled = true
    const desktopless = createDefrag({ ...s, options: {} })
    expect(() => desktopless.start()).toThrow('Defrag runs on Desktop.')
    s.store.counts = { groups: 0, unlinked: 0, entities: 0, repeats: 0, conflicts: 0, flags: 0 }
    // Unchecked pairs alone never start a run.
    s.store.waitingSuggestions = () => ({
      items: [
        {
          kind: 'possible_repeat',
          suggestionId: 'pair',
          subjects: [],
          reason: 'Close wording.',
          problem: null,
          createdAt: 1,
        },
      ],
      more: 3,
    })
    expect(() => s.defrag.start()).toThrow('Nothing is waiting for Defrag.')
    expect(s.store.runs).toEqual([])
    s.store.counts.flags = 1
    s.store.runs.push({ ...s.store.createRun(), state: 'running' })
    expect(() => s.defrag.start()).toThrow('Defrag is already running.')
    s.store.runs.at(-1)!.state = 'queued'
    expect(() => s.defrag.start()).toThrow('Defrag is already waiting to start.')
    await s.queue.pause()
    s.store.runs.at(-1)!.state = 'done'
    expect(() => s.defrag.start()).toThrow('Brain is resetting.')
    await s.queue.dispose()
  })

  it('runs the local pass, then one turn with the waiting counts, and records the result', async () => {
    const s = setup()
    const sweep = vi.spyOn(s.store, 'sweep').mockReturnValue({
      coverage: { ...emptyBrainTidyCoverage(), phase: 'done' },
      suggestions: 1,
      folded: 2,
      unlinked: 0,
      operationIds: [],
    })
    const refresh = vi.spyOn(s.search, 'refresh')
    s.defrag.start()
    expect(s.store.latestRun()).toMatchObject({ state: 'queued', startedAt: null })
    await vi.waitFor(() => expect(s.store.latestRun()?.state).toBe('done'))
    expect(sweep).toHaveBeenCalledWith('all')
    expect(refresh).toHaveBeenCalled()
    expect(s.host.turn).toHaveBeenCalledOnce()
    expect(vi.mocked(s.host.turn).mock.calls[0]![0]).toBe(
      'Defrag. 3 waiting: 1 group, 2 repeats. Start with brain_waiting.',
    )
    expect(s.store.latestRun()).toMatchObject({
      state: 'done',
      total: 3,
      startedAt: 500,
      finishedAt: 500,
      sessionPath: '/brain/Brain/lane.jsonl',
      error: null,
      rulesChanged: false,
    })
    expect(s.changed).toHaveBeenCalled()
    await s.queue.dispose()
  })

  it('finishes at once when the local pass leaves nothing waiting', async () => {
    const s = setup()
    vi.spyOn(s.store, 'sweep').mockImplementation(() => {
      s.store.counts = { groups: 0, unlinked: 0, entities: 0, repeats: 0, conflicts: 0, flags: 0 }
      return {
        coverage: { ...emptyBrainTidyCoverage(), phase: 'done' },
        suggestions: 0,
        folded: 2,
        unlinked: 0,
        operationIds: [],
      }
    })
    s.defrag.start()
    await vi.waitFor(() => expect(s.store.latestRun()?.state).toBe('done'))
    expect(s.store.latestRun()?.total).toBe(0)
    expect(s.host.turn).not.toHaveBeenCalled()
    await s.queue.dispose()
  })

  it.each([
    [
      { ...finished, outcome: 'stopped', rulesChanged: true },
      { state: 'stopped', rulesChanged: true },
    ],
    [
      {
        ...finished,
        outcome: 'failed',
        error: 'pi exited at /Users/rina/.pi/agent/x.jsonl\n  at x',
      },
      { state: 'failed', error: 'pi exited at a file' },
    ],
    [
      { ...finished, outcome: 'failed', error: null },
      { state: 'failed', error: 'Brain Agent stopped before it finished.' },
    ],
  ] as const)('maps the turn outcome %j', async (turn, expected) => {
    const s = setup(async () => turn)
    s.defrag.start()
    await vi.waitFor(() => expect(s.store.latestRun()?.state).not.toMatch(/queued|running/))
    expect(s.store.latestRun()).toMatchObject(expected)
    await s.queue.dispose()
  })

  it('a host that throws fails the run with one plain line', async () => {
    const s = setup(async () => {
      throw new Error('No lane could start.\n    at spawn (/app/main.js:1:1)')
    })
    s.defrag.start()
    await vi.waitFor(() => expect(s.store.latestRun()?.state).toBe('failed'))
    expect(s.store.latestRun()?.error).toBe('No lane could start.')
    await s.queue.dispose()
  })

  it('waits behind reads queued earlier, and holds reads queued after it', async () => {
    const order: string[] = []
    const s = setup(async () => {
      order.push('defrag')
      return finished
    })
    const first = s.store.enqueue({ ...HARBOR_JOB, sessionId: 'rina' }, 'queued')
    s.queue.kick()
    await flush()
    s.defrag.start()
    const later = s.store.enqueue({ ...HARBOR_JOB, sessionId: 'tom' }, 'queued')
    s.queue.kick()
    await flush()
    expect(s.host.turn).not.toHaveBeenCalled()
    expect(s.store.latestRun()?.state).toBe('queued')
    order.push(s.runs[0]!.id)
    s.runs[0]!.finish()
    await vi.waitFor(() => expect(s.runs).toHaveLength(2))
    order.push(s.runs[1]!.id)
    expect(order).toEqual([first.id, 'defrag', later.id])
    s.runs[1]!.finish()
    await s.queue.dispose()
  })

  it('Stop on a queued run means it never starts', async () => {
    const s = setup()
    s.store.enqueue(HARBOR_JOB, 'queued')
    s.queue.kick()
    await flush()
    s.defrag.start()
    s.defrag.stop()
    expect(s.store.latestRun()).toMatchObject({ state: 'stopped', finishedAt: 500 })
    s.runs[0]!.finish()
    await flush()
    await flush()
    expect(s.host.turn).not.toHaveBeenCalled()
    expect(s.runEnded).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: 'stopped' }),
    )
    expect(s.store.latestRun()?.state).toBe('stopped')
    await s.queue.dispose()
  })

  it('Stop on a running run aborts the turn, and the run ends stopped', async () => {
    let signal: AbortSignal | undefined
    const s = setup(
      (_message, abort) =>
        new Promise<BrainAgentTurn>((resolve) => {
          signal = abort
          abort.addEventListener('abort', () => resolve({ ...finished, outcome: 'stopped' }))
        }),
    )
    s.defrag.start()
    await vi.waitFor(() => expect(s.host.turn).toHaveBeenCalled())
    expect(s.store.latestRun()?.state).toBe('running')
    s.defrag.stop()
    expect(signal?.aborted).toBe(true)
    await vi.waitFor(() => expect(s.store.latestRun()?.state).toBe('stopped'))
    expect(s.store.latestRun()?.error).toBeNull()
    await s.queue.dispose()
  })

  it('leaves an unfinished run for the next start to report as interrupted', async () => {
    const s = setup(
      (_message, abort) =>
        new Promise((resolve) => abort.addEventListener('abort', () => resolve(finished))),
    )
    s.defrag.start()
    await vi.waitFor(() => expect(s.store.latestRun()?.state).toBe('running'))
    s.defrag.dispose()
    await s.queue.dispose()
    expect(s.store.latestRun()?.state).toBe('running')
  })
})
