// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HostFolderBrowser } from './HostFolderBrowser'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
let root: Root, container: HTMLDivElement
const invoke = vi.fn(),
  close = vi.fn(),
  added = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke })
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.capabilities.push('workspaces.write')
  useRemoteLanesStore.setState({ hosts })
  invoke.mockReset().mockImplementation(async (channel, _host, path) =>
    channel === 'hosts:listFolders'
      ? {
          path: path ?? '',
          truncated: false,
          entries: [{ name: 'Projects', isRepository: true, configured: false }],
        }
      : { repositoryId: 'new' },
  )
  close.mockReset()
  added.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(): Promise<void> {
  await act(async () =>
    root.render(<HostFolderBrowser hostId={MOCK_HOST_ID} onClose={close} onAdded={added} />),
  )
}
function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!
}
it('browses Host-relative folders, shows git badges and adds exactly the selected folder', async () => {
  await render()
  await act(async () => button('Projects').click())
  expect(invoke).toHaveBeenCalledWith('hosts:listFolders', MOCK_HOST_ID, 'Projects')
  expect(document.body.textContent).toContain('git')
  await act(async () => button('Add this folder').click())
  expect(invoke).toHaveBeenCalledWith('hosts:addRepository', MOCK_HOST_ID, 'Projects')
  expect(added).toHaveBeenCalledWith('new')
  expect(close).toHaveBeenCalledOnce()
})
it.each(['down', 'capability'])('refuses %s without reading This Mac', async (failure) => {
  useRemoteLanesStore.setState((s) => ({
    hosts: {
      [MOCK_HOST_ID]: {
        ...s.hosts[MOCK_HOST_ID]!,
        ...(failure === 'down' ? { state: 'down' as const } : { capabilities: [] }),
      },
    },
  }))
  await render()
  expect(invoke).not.toHaveBeenCalled()
  expect(button('Add this folder').disabled).toBe(true)
})
it('keeps add failure inside the modal with a fixed error', async () => {
  await render()
  invoke.mockRejectedValue(new Error('/private/path'))
  await act(async () => button('Add this folder').click())
  expect(close).not.toHaveBeenCalled()
  expect(document.querySelector('[role=alert]')?.textContent).toContain('could not add')
  expect(document.body.textContent).not.toContain('/private/path')
})
