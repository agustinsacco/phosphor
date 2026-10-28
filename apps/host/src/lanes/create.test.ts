import { beforeEach, expect, it, vi } from 'vitest'
import { createLane, type LaneSessions } from './create'
import { HostStore, type StoredLane } from './store'
import { prepareLaneFolder } from './worktree'

vi.mock('./worktree', () => ({
  prepareLaneFolder: vi.fn(),
  insideGitWorkTree: vi.fn(async () => true),
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
const ports = () => ({ sessions, store, log: () => {} })
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
    Object.assign(new Error('That branch already exists.'), { code: 'branch-exists' }),
  )
  await expect(
    createLane(ports(), {
      ...input,
      op: { ...input.op, worktree: { branch: 'feature', fresh: true } },
    }),
  ).rejects.toMatchObject({ code: 'branch-exists' })
  expect(sessions.start).not.toHaveBeenCalled()
  expect(store.ensureLane).not.toHaveBeenCalled()
  expect(undo).not.toHaveBeenCalled()
})
