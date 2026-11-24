import './__fixtures__/memory-history'
import { afterEach, describe, expect, vi } from 'vitest'
import type { DEFAULT_APP_PREFS } from '@shared/models'
import { enterDaemonMode } from './__fixtures__/daemon-mode'
import { recoveryCases } from './__fixtures__/recovery-cases'

/** Recreating a removed checkout with This Mac's lanes in the service, inside a lease. */

const state = vi.hoisted(() => ({
  prefs: null as unknown as typeof DEFAULT_APP_PREFS,
  live: [] as Array<{ workspacePath: string }>,
}))
vi.mock('../store', () => ({ getPrefs: () => state.prefs }))
vi.mock('../registry', () => ({ registry: { list: () => [] } }))
vi.mock('../pi/session-watcher', () => ({ notifyWorkspaceSessions: vi.fn() }))

const service = enterDaemonMode(state)
afterEach(() => expect(service.leases.size).toBe(0))

describe('recreating a removed checkout', () => recoveryCases(state))
