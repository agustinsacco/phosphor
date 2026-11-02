import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as exec from '@phosphor/session-runtime/git/git-exec'
import { createLane, type LaneSessions } from './create'
import { createRepositoryLocks } from './repository-lock'
import { HostStore, type StoredLane } from './store'
import { gitTracksFolder, LaneFolderError } from './worktree'

const { git } = exec

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
    { sessions, store, log: () => {}, folders: createRepositoryLocks() },
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

// Only git's own "not a git repository" answer runs in place. Anything else asked
// for a branch and must not quietly edit the main checkout instead.
it('fails, never runs in place, when git itself cannot answer', async () => {
  vi.spyOn(exec, 'git').mockRejectedValue(
    Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
  )
  // Without git even the branch-name check fails; the point is that it fails.
  await expect(create()).rejects.toBeInstanceOf(LaneFolderError)
  expect(sessions.start).not.toHaveBeenCalled()
})

it('counts a bare repository as tracked', async () => {
  await git(folder, ['init', '--bare'])
  expect(await gitTracksFolder(folder)).toBe(true)
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
