// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostCapability } from '@shared/remote-host'
import { useHostFiles } from './machineFilesSource'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

afterEach(() => {
  useRemoteLanesStore.setState({ hosts: {} })
  vi.unstubAllGlobals()
})

it.each([
  ['ready', ['workspaces.read'], null],
  ['down', ['workspaces.read'], 'Machine not connected. Wait for reconnection.'],
  ['ready', [], 'This Host does not offer files to this device.'],
] as const)("a %s Host with %j: Machine files' refusal is %j", async (state, granted, refusal) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  const capabilities: HostCapability[] = [...granted]
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...host, state, capabilities } } })
  let unavailable: string | null | undefined
  function Probe(): null {
    unavailable = useHostFiles(MOCK_HOST_ID).unavailable
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  act(() => root.unmount())
  expect(unavailable).toBe(refusal)
})
