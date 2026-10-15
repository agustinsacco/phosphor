import { beforeEach, expect, it, vi } from 'vitest'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useArtifactsStore } from '@/stores/artifacts'
import { invalidateRemoteArtifactReads, refreshRemoteArtifacts } from './remoteArtifactRefresh'
import type { ArtifactSnapshot } from '@shared/artifacts'

const id = mockRemoteInfo.sessionId
const snapshot: ArtifactSnapshot = {
  id: 'card',
  title: 'Card',
  type: 'html',
  versions: [{ version: 1, title: 'Card', content: 'host', createdAt: 1 }],
}
const invoke = vi.fn()
beforeEach(() => {
  invalidateRemoteArtifactReads()
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.capabilities.push('artifacts.read')
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({
    activeSessionId: id,
    navSeq: 1,
    live: { [id]: { ...mockRemoteInfo, phosphorId: id } },
  })
  useArtifactsStore.setState({ bySession: {} })
  invoke.mockReset()
  vi.stubGlobal('window', { phosphor: { invoke } })
})

it.each(['switch', 'detach', 'connection', 'epoch', 'capability'] as const)(
  'drops late replies after %s',
  async (change) => {
    let resolve!: (snapshots: ArtifactSnapshot[]) => void
    invoke.mockImplementation(
      () =>
        new Promise<ArtifactSnapshot[]>((r) => {
          resolve = r
        }),
    )
    const request = refreshRemoteArtifacts(id)
    if (change === 'switch') useSessionsStore.setState({ activeSessionId: 'other', navSeq: 2 })
    if (change === 'detach') invalidateRemoteArtifactReads()
    const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
    if (change === 'connection') host.connectionToken = 'replacement'
    if (change === 'epoch') host.cursor = { epoch: 'aaaaaaaaaaaaaaaa', seq: 0 }
    if (change === 'capability') host.capabilities = ['sessions.read']
    resolve([snapshot])
    expect(await request).toBe(false)
    expect(useArtifactsStore.getState().bySession[id]).toBeUndefined()
  },
)

it('serializes and coalesces refreshes, replacing rather than merging versions', async () => {
  let resolve!: (snapshots: ArtifactSnapshot[]) => void
  invoke
    .mockImplementationOnce(
      () =>
        new Promise<ArtifactSnapshot[]>((r) => {
          resolve = r
        }),
    )
    .mockResolvedValue([])
  const first = refreshRemoteArtifacts(id)
  const second = refreshRemoteArtifacts(id)
  const third = refreshRemoteArtifacts(id)
  expect(invoke).toHaveBeenCalledTimes(1)
  resolve([snapshot])
  await Promise.all([first, second, third])
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(useArtifactsStore.getState().bySession[id]).toEqual({})
})
