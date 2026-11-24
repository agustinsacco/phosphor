import './__fixtures__/memory-history'
import { vi } from 'vitest'
import type { DEFAULT_APP_PREFS } from '@shared/models'
import { safetyCases } from './__fixtures__/safety-cases'

const state = vi.hoisted(() => ({
  prefs: null as unknown as typeof DEFAULT_APP_PREFS,
  live: [] as Array<{ workspacePath: string }>,
}))
vi.mock('../store', () => ({ getPrefs: () => state.prefs }))
vi.mock('../registry', () => ({ registry: { list: () => state.live } }))
// Archived owners are covered by the archive suites; this one has no Electron app.
vi.mock('../archive/state', () => ({ assertNoArchivedOwners: async () => {} }))
vi.mock('../pi/session-watcher', () => ({ notifyWorkspaceSessions: vi.fn() }))
vi.mock('../fs/gh-cli', () => ({
  ghEvidence: () => ({ mergedPrHeads: async () => [], commitTree: async () => null }),
}))

safetyCases(state)
