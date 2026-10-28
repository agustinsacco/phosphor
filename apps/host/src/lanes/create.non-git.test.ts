import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { createLane, type LaneSessions } from './create'
import { HostStore, type StoredLane } from './store'

let folder: string
let sessions: LaneSessions
let store: HostStore
beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'lane-plain-')))
  sessions = {
    start: vi.fn(async () => ({ sessionId: 'session', sessionFile: null })),
    attach: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }
  // Only ensureLane is used; a prototype instance keeps this fake typed.
  store = Object.create(HostStore.prototype)
  vi.spyOn(store, 'ensureLane').mockImplementation(
    (lane) => ({ ...lane, laneId: 'plain' }) as unknown as StoredLane,
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(folder, { recursive: true, force: true })
})
const create = () =>
  createLane(
    { sessions, store, log: () => {} },
    {
      root: folder,
      op: {
        type: 'lane.create',
        repositoryId: '0000000000000000',
        worktree: { branch: 'phosphor/fix-it', fresh: true },
      },
      controller: { clientId: 'creator', label: 'Creator' },
    },
  )

// The Host offers "new branch" for every folder, and a folder git does not track
// failed as an internal error. This Mac hides the toggle there and runs in place.
it('runs in a folder git does not track even when a new branch was asked for', async () => {
  expect((await create()).laneId).toBe('plain')
  expect(sessions.start).toHaveBeenCalledWith({ repository: folder })
  expect(vi.mocked(store.ensureLane).mock.calls[0]?.[0]).toMatchObject({
    cwd: folder,
    branch: null,
    worktree: false,
  })
})

it('still gives a git folder its own worktree', async () => {
  const run = (args: string[]) => git(folder, args, { trim: true })
  await run(['init', '-b', 'main'])
  await run([
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'base',
  ])
  await create()
  const cwd = join(folder, '.phosphor', 'worktrees', 'phosphor-fix-it')
  expect(sessions.start).toHaveBeenCalledWith({ repository: cwd })
  expect(vi.mocked(store.ensureLane).mock.calls[0]?.[0]).toMatchObject({
    cwd,
    branch: 'phosphor/fix-it',
    worktree: true,
  })
})
