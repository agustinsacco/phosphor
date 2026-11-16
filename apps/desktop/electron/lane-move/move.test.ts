import type * as fsPromises from 'node:fs/promises'
import { beforeEach, expect, it, vi } from 'vitest'
import { TransferRefusal } from '@phosphor/session-runtime/lane-transfer/files'
import { createLaneMoves } from './move'

const fs = vi.hoisted(() => ({ mkdtemp: vi.fn(), rm: vi.fn() }))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fsPromises>()),
  mkdtemp: fs.mkdtemp,
  rm: fs.rm,
}))
vi.mock('@phosphor/session-runtime/lane-transfer/archive', () => ({
  sha256Of: vi.fn(async () => 'hash'),
}))
const local = vi.hoisted(() => ({
  inspect: vi.fn(),
  check: vi.fn(),
  export: vi.fn(),
  import: vi.fn(),
}))
vi.mock('./local', () => ({ localLanes: local }))
vi.mock('./remote', () => ({ remoteLaneTransfer: vi.fn() }))

const request = {
  source: { machine: 'local', sessionPath: '/sessions/a/source.jsonl' },
  target: { machine: 'local', workspace: '/target' },
  marks: { pinned: false, marker: null },
} as const
const saved = {
  sessionPath: '/sessions/b/copy.jsonl',
  workspace: '/target/.phosphor/worktrees/agustin-arena',
}
const taken = 'A branch named agustin/arena already exists in target.'

function setup() {
  const log = vi.fn()
  const moves = createLaneMoves({
    connection: vi.fn() as never,
    label: () => 'Host',
    branchPrefix: () => 'agustin/',
    tempDir: () => '/temp',
    log,
  })
  return { moves, log }
}

beforeEach(() => {
  vi.clearAllMocks()
  fs.mkdtemp.mockResolvedValue('/temp/phosphor-lane-1')
  fs.rm.mockResolvedValue(undefined)
  local.inspect.mockResolvedValue({ facts: { bytes: 42 } })
  local.check.mockImplementation(async () => ({
    mode: 'new-branch',
    branch: 'agustin/arena',
    workspace: 'target',
    blockers: [],
  }))
  local.export.mockResolvedValue({ size: 42, sha256: 'hash' })
  local.import.mockResolvedValue(saved)
})

it('keeps a saved move when its temporary bundle cannot be removed', async () => {
  const { moves, log } = setup()
  fs.rm.mockRejectedValue(Object.assign(new Error('EACCES: denied /temp/x'), { code: 'EACCES' }))
  await expect(moves.move(request)).resolves.toEqual({ machine: 'local', ...saved })
  expect(log).toHaveBeenCalledWith('temp cleanup failed', { error: 'Error', code: 'EACCES' })
  // The next move is not blocked by the one that failed to clean up.
  await expect(moves.move(request)).resolves.toEqual({ machine: 'local', ...saved })
})

it('keeps the original failure when cleanup fails too', async () => {
  const { moves } = setup()
  local.import.mockRejectedValue(new Error('disk full'))
  fs.rm.mockRejectedValue(new Error('EACCES'))
  await expect(moves.move(request)).rejects.toThrow('disk full')
})

it('logs each check and move by outcome, with fixed fields and no error text', async () => {
  const { moves, log } = setup()
  await moves.plan(request)
  await moves.move(request)
  local.import.mockRejectedValueOnce(new TransferRefusal(taken))
  await moves.move(request)
  local.import.mockRejectedValueOnce(new Error('fatal: https://token@example.test/o/r'))
  await expect(moves.move(request)).rejects.toThrow()
  local.check.mockRejectedValueOnce(new Error('stderr: secret'))
  await expect(moves.plan(request)).rejects.toThrow()
  const route = { from: 'local', to: 'local', ms: expect.any(Number) }
  const checked = { ...route, mode: 'new-branch', bytes: 42, blockers: [] }
  expect(log.mock.calls).toEqual([
    ['checked', { purpose: 'dialog', ...checked }],
    ['checked', { purpose: 'move', ...checked }],
    ['moved', { ...route, ...saved }],
    ['checked', { purpose: 'move', ...checked }],
    ['move refused', { ...route, blockers: [taken] }],
    ['checked', { purpose: 'move', ...checked }],
    ['move failed', { ...route, error: 'Error' }],
    ['check failed', { purpose: 'dialog', ...route, error: 'Error' }],
  ])
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/token|secret/)
})

it('refuses a second move while one is running, and logs it', async () => {
  const { moves, log } = setup()
  let finish!: (value: typeof saved) => void
  local.import.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
  const first = moves.move(request)
  await vi.waitFor(() => expect(local.import).toHaveBeenCalled())
  await expect(moves.move(request)).resolves.toEqual({
    blockers: ['Another lane is moving. Wait for it to finish.'],
  })
  expect(log).toHaveBeenCalledWith('move refused', {
    from: 'local',
    to: 'local',
    ms: expect.any(Number),
    blockers: ['Another lane is moving. Wait for it to finish.'],
  })
  finish(saved)
  await expect(first).resolves.toEqual({ machine: 'local', ...saved })
})
