import './__fixtures__/memory-history'
import { afterEach, expect, it, vi } from 'vitest'
import type { DEFAULT_APP_PREFS } from '@shared/models'
import { LOCAL_SERVICE_UNAVAILABLE } from '../local-machine/lease'
import { enterDaemonMode } from './__fixtures__/daemon-mode'
import { safetyCases } from './__fixtures__/safety-cases'
import { removeReviewedWorktree } from './removal'
import { recreateWorktree } from './recovery'

/**
 * The safety cases with This Mac's lanes in the service: Desktop's registry
 * is empty, the service's projection says which lanes run, and every removal
 * runs inside a workspace lease the service refuses over a live lane.
 */

const state = vi.hoisted(() => ({
  prefs: null as unknown as typeof DEFAULT_APP_PREFS,
  live: [] as Array<{ workspacePath: string }>,
}))
vi.mock('../store', () => ({ getPrefs: () => state.prefs }))
// Desktop runs no lanes in daemon mode; only the service's projection may count.
vi.mock('../registry', () => ({ registry: { list: () => [] } }))
vi.mock('../archive/state', () => ({ assertNoArchivedOwners: async () => {} }))
vi.mock('../pi/session-watcher', () => ({ notifyWorkspaceSessions: vi.fn() }))
vi.mock('../fs/gh-cli', () => ({
  ghEvidence: () => ({ mergedPrHeads: async () => [], commitTree: async () => null }),
}))

const service = enterDaemonMode(state)
afterEach(() => {
  // Every lease taken was released.
  expect(service.leases.size).toBe(0)
  service.state = 'ready'
})

safetyCases(state)

it('took a workspace lease for the removals above', () => {
  expect(service.calls.filter((c) => c.method === 'owner.lease.take').length).toBeGreaterThan(0)
})

it('fails closed while the service is not connected', async () => {
  service.state = 'reconnecting'
  const checkout = '/nonexistent/m2b/repo/.phosphor/worktrees/a'
  await expect(removeReviewedWorktree('/nonexistent/m2b/repo', checkout, {})).rejects.toThrow(
    LOCAL_SERVICE_UNAVAILABLE,
  )
  await expect(recreateWorktree(checkout, 'fresh')).rejects.toThrow(LOCAL_SERVICE_UNAVAILABLE)
})
