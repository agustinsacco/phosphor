import { expect, it, vi } from 'vitest'
import type {
  BrainApi,
  BrainMutationCheck,
  BrainSurfaceRuntime,
} from '@phosphor/brain-runtime/types'
import { DEFAULT_BRAIN_PREFS, type BrainStatus } from '@phosphor/shared/brain'
import { projectHostBrainResult } from '@phosphor/shared/host-brain-result'
import type { BrainSurfaceAuthority } from '../api/brain-adapter'
import { createBrainSurfaceHandlers, type BrainSurfaceAgent } from './surface-service'

const generation = 'efe34a23-57d6-4da0-864d-80218622deda'
const lane = {
  laneId: '7cd940d8-068f-46ff-84a2-a917a74f027b',
  sessionId: 'harbor-pi',
  sessionPath: '/Harbor/Ledger.jsonl',
  title: 'Harbor',
}
const expected = { generation, revision: 2 }

const extractionEvidence: BrainSurfaceRuntime['evidence'] = async (_id, sourceAllowed) => {
  const exists = sourceAllowed(lane)
  return {
    ...lane,
    jobId: 'harbor-job',
    job: null,
    outcomes: [],
    memories: [],
    startedAt: 1,
    finishedAt: 2,
    source: {
      exists,
      segments: exists
        ? [
            {
              entryId: 'entry',
              role: 'user',
              label: 'Ledger',
              observedAt: 1,
              text: 'Northwind',
            },
          ]
        : [],
    },
  } as unknown as Awaited<ReturnType<BrainSurfaceRuntime['evidence']>>
}

function setup() {
  let allowed = true
  let visible = true
  let substituted = false
  let resume: () => void = () => {}
  let checkAtCommit: BrainMutationCheck | undefined
  const status = {
    generation,
    revision: 2,
    prefs: { ...DEFAULT_BRAIN_PREFS, enabled: true },
    jobs: [],
  } as unknown as BrainStatus
  const committed = vi.fn()
  const entityMemories = vi.fn(async () => ({ memories: [], entities: [], next: null }))
  const job = { ...lane, id: 'harbor-job', state: 'done' as const }
  const api = {
    status: async () => status,
    entityMemories,
    laneRead: async () => ({ job, memories: 2, replaceable: 1 }),
  } as unknown as BrainApi
  const runtime: BrainSurfaceRuntime = {
    api,
    guarded: (check) => {
      checkAtCommit = check
      return {
        queue: async () => {
          await new Promise<void>((resolve) => {
            resume = resolve
          })
          checkAtCommit?.(status, substituted ? { ...lane, sessionId: 'kestrel-pi' } : lane)
          committed()
          return status
        },
        forget: async () => {
          check(status)
          committed()
          return status
        },
      } as unknown as ReturnType<BrainSurfaceRuntime['guarded']>
    },
    job: () => undefined,
    evidence: extractionEvidence,
  }
  const caller: BrainSurfaceAuthority = {
    client: { id: lane.laneId, label: 'Harbor' },
    connectionId: 'harbor',
    admit: () => allowed,
  }
  const handlers = createBrainSurfaceHandlers({
    runtime,
    lanes: { lane: (id) => (visible && id === lane.laneId ? lane : undefined), source: () => lane },
    agent: {} as BrainSurfaceAgent,
  })
  return {
    api,
    handlers,
    status,
    caller,
    committed,
    entityMemories,
    resume: () => resume(),
    hide: () => {
      visible = false
    },
    withdraw: () => {
      allowed = false
    },
    substitute: () => {
      substituted = true
    },
  }
}

it('resolves a lane filter to exact visible provenance, never broadening an inaccessible filter', async () => {
  const s = setup()
  const request = {
    method: 'brain:entityMemories',
    args: ['rina', { laneId: lane.laneId }, null],
  } as const
  const query = () =>
    s.handlers['brain:entityMemories']({ ...request, args: [...request.args] }, s.caller)
  expect(await query()).toMatchObject({ status: 'ok' })
  expect(s.entityMemories).toHaveBeenCalledWith('rina', { sessionId: 'harbor-pi' }, null)
  s.hide()
  expect(await query()).toEqual({ status: 'not-found' })
  expect(s.entityMemories).toHaveBeenCalledTimes(1)
})

it('uses the visible Host lane title for reads, not a prompt-derived saved title', async () => {
  const s = setup()
  const title = 'Northwind prompt from a moved transcript'
  const job: BrainStatus['jobs'][number] = {
    ...lane,
    id: 'harbor-job',
    title,
    scope: 'Harbor',
    branch: null,
    model: '',
    state: 'done',
    replaces: null,
    memories: 1,
    leafId: null,
    error: null,
    queuedAt: 1,
    startedAt: 1,
    runStartedAt: null,
    fromLeafId: null,
    finishedAt: 2,
    usage: null,
    progress: null,
  }
  s.status.jobs.push(job)
  const status = () => s.handlers['brain:status']({ method: 'brain:status', args: [] }, s.caller)
  await expect(status()).resolves.toMatchObject({ data: { jobs: [{ title: 'Harbor' }] } })
  s.hide()
  await expect(status()).resolves.toMatchObject({ data: { jobs: [{ title: 'Unavailable lane' }] } })
  expect(s.status.jobs[0]?.title).toBe(title)
})

it('projects lane state using only the admitted saved transcript and explicit exclusion', async () => {
  const s = setup()
  s.status.prefs.neverRead = { titles: ['Kestrel'], sessionIds: [lane.sessionId] }
  const request = { method: 'brain:laneState' as const, args: [lane.laneId] as [string] }
  expect(await s.handlers['brain:laneState'](request, s.caller)).toEqual({
    status: 'ok',
    data: {
      excluded: true,
      activeJob: null,
      lastRead: { jobId: 'harbor-job', memories: 2, replaceable: 1 },
    },
  })
  s.hide()
  expect(await s.handlers['brain:laneState'](request, s.caller)).toEqual({ status: 'not-found' })
})

it.each(['withdrawal', 'generation', 'substitute'] as const)(
  'refuses a queue commit after %s',
  async (reason) => {
    const s = setup()
    const pending = s.handlers['brain:queue'](
      { method: 'brain:queue', args: [lane.laneId], expected },
      s.caller,
    )
    if (reason === 'withdrawal') s.withdraw()
    if (reason === 'generation') s.status.generation = `${generation}-reset`
    if (reason === 'substitute') s.substitute()
    s.resume()
    expect(await pending).toEqual({
      status:
        reason === 'withdrawal' ? 'unavailable' : reason === 'substitute' ? 'not-found' : 'stale',
    })
    expect(s.committed).not.toHaveBeenCalled()
  },
)

it('revision-conflicts before a destructive change and only projects authorized source bookmarks', async () => {
  const s = setup()
  const stale = { ...expected, revision: 1 }
  expect(
    await s.handlers['brain:forget'](
      { method: 'brain:forget', args: ['ledger'], expected: stale },
      s.caller,
    ),
  ).toEqual({ status: 'stale' })
  expect(s.committed).not.toHaveBeenCalled()
  const read = async () => {
    const result = await s.handlers['brain:extraction'](
      { method: 'brain:extraction', args: ['harbor-job'] },
      s.caller,
    )
    if (result.status !== 'ok') throw new Error(result.status)
    return projectHostBrainResult('brain:extraction', result.data)?.value
  }
  expect(await read()).toMatchObject({ sourceLaneId: lane.laneId, source: { exists: true } })
  s.hide()
  const hidden = await read()
  expect(hidden).toMatchObject({ sourceLaneId: null, source: { exists: false, segments: [] } })
  expect(JSON.stringify(hidden)).not.toContain(lane.sessionPath)
})
