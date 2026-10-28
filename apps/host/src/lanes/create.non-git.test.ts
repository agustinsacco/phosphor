import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLane, type LaneSessions } from './create'
import { HostStore, type StoredLane } from './store'

let folder: string
beforeEach(() => {
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'lane-plain-')))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(folder, { recursive: true, force: true })
})

// The Host offers "new branch" for every folder, and a folder git does not track
// failed as an internal error. This Mac hides the toggle there and runs in place.
it('runs in a folder git does not track even when a new branch was asked for', async () => {
  const sessions: LaneSessions = {
    start: vi.fn(async () => ({ sessionId: 'session', sessionFile: null })),
    attach: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }
  // Only ensureLane is used; a prototype instance keeps this fake typed.
  const store: HostStore = Object.create(HostStore.prototype)
  const ensure = vi
    .spyOn(store, 'ensureLane')
    .mockImplementation((lane) => ({ ...lane, laneId: 'plain' }) as unknown as StoredLane)
  const lane = await createLane(
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
  expect(lane.laneId).toBe('plain')
  expect(sessions.start).toHaveBeenCalledWith({ repository: folder })
  expect(ensure.mock.calls[0]?.[0]).toMatchObject({ cwd: folder, branch: null, worktree: false })
})
