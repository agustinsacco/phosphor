import { afterEach, expect, it, vi } from 'vitest'
import type { HostsSnapshot } from '@shared/ipc'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { refreshHostsSnapshot } from './hostsSnapshotRead'
import { attachRemoteLanesListener, useRemoteLanesStore } from './remoteLanes'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
afterEach(() => vi.unstubAllGlobals())

it('resolves once the read coalesced with one in flight has landed (settings F3)', async () => {
  const stale: HostsSnapshot = {}
  const fresh = structuredClone(mockRemoteHosts)
  let first!: (hosts: HostsSnapshot) => void
  const invoke = vi.fn((channel: string) => {
    if (channel !== 'hosts:snapshot') return Promise.resolve(undefined)
    if (invoke.mock.calls.filter(([c]) => c === 'hosts:snapshot').length > 1)
      return Promise.resolve(fresh)
    return new Promise<HostsSnapshot>((resolve) => (first = resolve))
  })
  const off = () => () => undefined
  vi.stubGlobal('window', {
    phosphor: { invoke, onHostsChanged: off, onHostAttention: off, onHostOpenLane: off },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('document', { hasFocus: () => false })
  const detach = attachRemoteLanesListener()
  try {
    const landed = refreshHostsSnapshot().then(() => useRemoteLanesStore.getState().hosts)
    first(stale)
    expect((await landed)[MOCK_HOST_ID]).toBe(fresh[MOCK_HOST_ID])
  } finally {
    detach()
  }
})
