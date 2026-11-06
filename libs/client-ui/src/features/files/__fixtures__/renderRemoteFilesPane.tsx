import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import type { HostCapability } from '@shared/remote-host'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { RemoteFilesPane } from '../RemoteFilesPane'

export const remoteFilesHostId = MOCK_HOST_ID
export const remoteFilesSessionId = mockRemoteInfo.sessionId

/**
 * The mock Host lane, live in the sessions store, on its ready Host granting `capabilities`.
 * `controller` makes this device the lane's controller.
 */
export function seedRemoteFilesLane({
  capabilities,
  controller = false,
}: {
  capabilities: HostCapability[]
  controller?: boolean
}): void {
  useSessionsStore.setState({
    live: { [remoteFilesSessionId]: { phosphorId: remoteFilesSessionId, ...mockRemoteInfo } },
  })
  const fixture = mockRemoteHosts[remoteFilesHostId]!
  const lanes = controller
    ? fixture.lanes.map((lane) => ({
        ...lane,
        control: { ...lane.control, controller: { self: true, label: 'Desktop', connected: true } },
      }))
    : fixture.lanes
  useRemoteLanesStore.setState({
    hosts: { [remoteFilesHostId]: { ...fixture, state: 'ready', capabilities, lanes } },
  })
}

/**
 * Seeds the lane, stubs `window.phosphor` and renders its RemoteFilesPane. `render`
 * re-renders it (Files or Changes); the caller unmounts `root`.
 */
export async function renderRemoteFilesPane({
  phosphor,
  changes = false,
  ...lane
}: Parameters<typeof seedRemoteFilesLane>[0] & {
  phosphor: object
  changes?: boolean
}): Promise<{
  container: HTMLDivElement
  root: Root
  render: (changes?: boolean) => Promise<void>
}> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seedRemoteFilesLane(lane)
  vi.stubGlobal('phosphor', phosphor)
  const container = document.createElement('div')
  const root = createRoot(container)
  const render = async (showChanges = false): Promise<void> => {
    await act(async () =>
      root.render(
        <RemoteFilesPane
          workspacePath={mockRemoteInfo.workspacePath}
          sessionId={remoteFilesSessionId}
          changes={showChanges}
        />,
      ),
    )
  }
  await render(changes)
  return { container, root, render }
}
