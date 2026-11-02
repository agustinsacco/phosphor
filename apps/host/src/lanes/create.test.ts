import { beforeEach, expect, it, vi } from 'vitest'
import { createLane, type LaneSessions } from './create'
import { createRepositoryLocks } from './repository-lock'
import { HostStore, type StoredLane } from './store'
import { LaneFolderError, prepareLaneFolder } from './worktree'
import type * as Worktree from './worktree'

vi.mock('./worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof Worktree>()),
  prepareLaneFolder: vi.fn(),
  gitTracksFolder: vi.fn(async () => true),
}))
let order: string[]
let sessions: LaneSessions
let store: HostStore
const lane: StoredLane = {
  laneId: 'created-lane',
  repositoryId: '0000000000000000',
  cwd: '/repo/worktree',
  sessionFile: null,
  removedAt: null,
  title: null,
  branch: 'feature',
  worktree: true,
  model: null,
  activity: 'idle',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  attention: 0,
  read: 0,
  control: { fence: 1, controller: null },
}
const input = {
  root: '/repo',
  op: {
    type: 'lane.create',
    repositoryId: '0000000000000000',
    worktree: { branch: 'feature' },
    name: 'Name',
    provider: 'provider',
    model: 'model',
    thinkingLevel: 'high',
  },
  controller: { clientId: 'creator', label: 'Creator' },
} as const
const undo = vi.fn(async () => {
  order.push('undo')
})
beforeEach(() => {
  order = []
  vi.clearAllMocks()
  vi.mocked(prepareLaneFolder).mockImplementation(async () => {
    order.push('folder')
    return { cwd: '/repo/worktree', branch: 'feature', undo }
  })
  sessions = {
    start: vi.fn(async () => {
      order.push('start')
      return { sessionId: 'session', sessionFile: null }
    }),
    attach: vi.fn(async () => {
      order.push('attach')
    }),
    stop: vi.fn(async () => {
      order.push('stop')
    }),
  }
  // Only ensureLane is used; a prototype instance keeps this fake typed.
  store = Object.create(HostStore.prototype)
  vi.spyOn(store, 'markRemoved').mockImplementation(() => {
    order.push('remove')
  })
  vi.spyOn(store, 'ensureLane').mockImplementation(() => {
    order.push('ensure')
    return lane
  })
})
const ports = () => ({ sessions, store, log: () => {}, folders: createRepositoryLocks() })
it('prepares, starts, stores with the creator, then attaches', async () => {
  expect(await createLane(ports(), { ...input, onStored: () => order.push('hold') })).toBe(lane)
  expect(order).toEqual(['folder', 'start', 'ensure', 'hold', 'attach'])
  expect(sessions.start).toHaveBeenCalledWith({
    repository: '/repo/worktree',
    name: 'Name',
    provider: 'provider',
    model: 'model',
    thinkingLevel: 'high',
  })
  expect(store.ensureLane).toHaveBeenCalledWith(
    {
      repositoryId: input.op.repositoryId,
      cwd: '/repo/worktree',
      sessionFile: null,
      worktree: true,
      title: 'Name',
      branch: 'feature',
      provider: 'provider',
      model: 'model',
    },
    { controller: input.controller },
  )
  expect(sessions.attach).toHaveBeenCalledWith(lane.laneId, 'session')
  expect(undo).not.toHaveBeenCalled()
})
it.each(['folder', 'start', 'ensure', 'attach'])(
  'cleans up after %s failure and preserves the original error',
  async (step) => {
    const original = new Error('original')
    if (step === 'folder') vi.mocked(prepareLaneFolder).mockRejectedValueOnce(original)
    if (step === 'start') vi.mocked(sessions.start).mockRejectedValueOnce(original)
    if (step === 'ensure')
      vi.mocked(store.ensureLane).mockImplementationOnce(() => {
        throw original
      })
    if (step === 'attach') vi.mocked(sessions.attach).mockRejectedValueOnce(original)
    vi.mocked(sessions.stop).mockImplementation(async () => {
      order.push('stop')
      throw new Error('stop failure')
    })
    await expect(createLane(ports(), input)).rejects.toBe(original)
    if (step === 'folder') expect(order).toEqual([])
    else if (step === 'start') expect(order).toEqual(['folder', 'undo'])
    else {
      expect(order.slice(-2)).toEqual(['stop', 'undo'])
      if (step === 'attach') expect(store.markRemoved).toHaveBeenCalledWith(lane.laneId)
      else expect(store.markRemoved).not.toHaveBeenCalled()
    }
  },
)

it('ignores removal errors while still stopping and undoing', async () => {
  const original = new Error('attach')
  vi.mocked(sessions.attach).mockRejectedValueOnce(original)
  vi.mocked(store.markRemoved).mockImplementationOnce(() => {
    throw new Error('remove')
  })
  await expect(createLane(ports(), input)).rejects.toBe(original)
  expect(order.slice(-2)).toEqual(['stop', 'undo'])
})

it('ignores synchronous stop errors and still undoes the folder', async () => {
  const original = new Error('attach')
  vi.mocked(sessions.attach).mockRejectedValueOnce(original)
  vi.mocked(sessions.stop).mockImplementationOnce(() => {
    throw new Error('sync stop')
  })
  await expect(createLane(ports(), input)).rejects.toBe(original)
  expect(undo).toHaveBeenCalledTimes(1)
})

it('closed creation does not store, attach or mark removed, but stops and undoes', async () => {
  await expect(createLane({ ...ports(), closed: () => true }, input)).rejects.toThrow('closed')
  expect(order).toEqual(['folder', 'start', 'stop', 'undo'])
  expect(store.ensureLane).not.toHaveBeenCalled()
  expect(store.markRemoved).not.toHaveBeenCalled()
  expect(sessions.attach).not.toHaveBeenCalled()
})
it('close after storing skips attach and store rollback, but stops and undoes', async () => {
  let closed = false
  await expect(
    createLane(
      { ...ports(), closed: () => closed },
      {
        ...input,
        onStored: () => {
          closed = true
        },
      },
    ),
  ).rejects.toThrow('closed')
  expect(order).toEqual(['folder', 'start', 'ensure', 'stop', 'undo'])
  expect(store.markRemoved).not.toHaveBeenCalled()
  expect(sessions.attach).not.toHaveBeenCalled()
})

it('a fresh branch refusal never creates a row or starts pi', async () => {
  vi.mocked(prepareLaneFolder).mockRejectedValue(
    new LaneFolderError('That branch already exists.', 'branch-exists'),
  )
  await expect(
    createLane(ports(), {
      ...input,
      op: { ...input.op, worktree: { branch: 'feature', fresh: true } },
    }),
  ).rejects.toMatchObject({ code: 'branch-exists' })
  expect(vi.mocked(prepareLaneFolder).mock.calls.map(([call]) => call.worktree?.branch)).toEqual([
    'feature',
    'feature-2',
    'feature-3',
    'feature-4',
    'feature-5',
  ])
  expect(sessions.start).not.toHaveBeenCalled()
  expect(store.ensureLane).not.toHaveBeenCalled()
  expect(undo).not.toHaveBeenCalled()
})

it('stores the free name a fresh branch was created under', async () => {
  vi.mocked(prepareLaneFolder)
    .mockRejectedValueOnce(new LaneFolderError('That branch already exists.', 'branch-exists'))
    .mockRejectedValueOnce(new LaneFolderError('That branch already exists.', 'branch-exists'))
    .mockImplementationOnce(async ({ worktree }) => ({
      cwd: '/repo/worktree-3',
      branch: worktree?.branch ?? null,
      undo,
    }))
  await createLane(ports(), {
    ...input,
    op: { ...input.op, worktree: { branch: 'feature-', fresh: true } },
  })
  expect(vi.mocked(prepareLaneFolder).mock.calls.map(([call]) => call.worktree)).toEqual([
    { branch: 'feature-', fresh: true },
    { branch: 'feature-2', fresh: true },
    { branch: 'feature-3', fresh: true },
  ])
  expect(store.ensureLane).toHaveBeenCalledWith(
    expect.objectContaining({ branch: 'feature-3', cwd: '/repo/worktree-3', worktree: true }),
    { controller: input.controller },
  )
})

it('tries one name for an existing branch, and fails on any other folder refusal', async () => {
  const taken = new LaneFolderError('That branch already exists.', 'branch-exists')
  vi.mocked(prepareLaneFolder).mockRejectedValueOnce(taken)
  await expect(createLane(ports(), input)).rejects.toBe(taken)
  const invalid = new LaneFolderError('That branch name is not valid.')
  vi.mocked(prepareLaneFolder).mockRejectedValueOnce(invalid)
  await expect(
    createLane(ports(), {
      ...input,
      op: { ...input.op, worktree: { branch: 'feature', fresh: true } },
    }),
  ).rejects.toBe(invalid)
  expect(prepareLaneFolder).toHaveBeenCalledTimes(2)
})

it('reports branching then starting for a worktree, and only starting in place', async () => {
  const phases: string[] = []
  await createLane(ports(), { ...input, phase: (phase) => phases.push(phase) })
  await createLane(ports(), {
    ...input,
    op: { ...input.op, worktree: null },
    phase: (phase) => phases.push(phase),
  })
  expect(phases).toEqual(['branching', 'starting', 'starting'])
})

it('ignores a throwing phase report', async () => {
  const phase = vi.fn(() => {
    throw new Error('delivery')
  })
  expect(await createLane(ports(), { ...input, phase })).toBe(lane)
  expect(phase).toHaveBeenCalledTimes(2)
})

it('takes turns per repository for worktree work and its undo, while pi boots overlap', async () => {
  const folders = createRepositoryLocks()
  const shared = { ...ports(), folders }
  let releaseFolder = () => {}
  const firstFolder = new Promise<void>((resolve) => (releaseFolder = resolve))
  vi.mocked(prepareLaneFolder).mockImplementationOnce(async () => {
    order.push('folder-1')
    await firstFolder
    return { cwd: '/repo/one', branch: 'one', undo }
  })
  vi.mocked(prepareLaneFolder).mockImplementationOnce(async () => {
    order.push('folder-2')
    return { cwd: '/repo/two', branch: 'two', undo }
  })
  let failBoots = (_error: Error) => {}
  const boots = new Promise<{ sessionId: string; sessionFile: null }>(
    (_resolve, reject) => (failBoots = reject),
  )
  vi.mocked(sessions.start).mockImplementation(async ({ repository }) => {
    order.push(`start ${repository}`)
    return boots
  })
  const phases: string[] = []
  const first = createLane(shared, input)
  const second = createLane(shared, { ...input, phase: (phase) => phases.push(phase) })
  await vi.waitFor(() => expect(phases).toEqual(['queued']))
  expect(order).toEqual(['folder-1'])
  releaseFolder()
  // Both boots are running before either settles; only the folder step waited.
  await vi.waitFor(() =>
    expect([...order].sort()).toEqual([
      'folder-1',
      'folder-2',
      'start /repo/one',
      'start /repo/two',
    ]),
  )
  expect(phases).toEqual(['queued', 'branching', 'starting'])
  failBoots(new Error('boot'))
  await expect(first).rejects.toThrow('boot')
  await expect(second).rejects.toThrow('boot')
  expect(undo).toHaveBeenCalledTimes(2)
})
