import { afterEach, expect, it, vi } from 'vitest'
import type { HostConnectionView } from '@shared/ipc'
import { loadArchives, useArchivesStore } from './archives'
import { useExtensionUiStore } from './extensionUi'
import { useRemoteLanesStore } from './remoteLanes'

const HOST = 'a0000000-0000-4000-8000-000000000001'
const host = (connectionToken: string) =>
  ({
    state: 'ready',
    connectionToken,
    label: 'Build box',
    laneArchive: true,
    capabilities: ['sessions.read'],
  }) as unknown as HostConnectionView
afterEach(() => {
  useArchivesStore.setState({ machines: {} })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('warns once per Host about large archives, not again after it reconnects', async () => {
  const invoke = vi.fn(async () => ({
    entries: [],
    bytes: 2e9,
    measuredAt: 1,
    measuring: false,
    truncated: false,
  }))
  vi.stubGlobal('window', { phosphor: { invoke } })
  const toast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast')
  useRemoteLanesStore.setState({ hosts: { [HOST]: host('first') } })
  await loadArchives(HOST)
  useRemoteLanesStore.setState({ hosts: { [HOST]: host('reconnected') } })
  await loadArchives(HOST)
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(toast).toHaveBeenCalledOnce()
})
