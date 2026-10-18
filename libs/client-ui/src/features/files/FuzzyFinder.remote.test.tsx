// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { FuzzyFinder, useFinderStore } from './FuzzyFinder'
import { useGlobalShortcuts } from '@/app/useGlobalShortcuts'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSessionsStore } from '@/stores/sessions'
import { openRemoteFile } from './remoteFileSelection'
import { mockRemoteInfo } from '@/dev/mockRemoteLanes'
vi.mock('./remoteFileSelection', () => ({ openRemoteFile: vi.fn().mockResolvedValue(undefined) }))

it('refreshes Mac → Host → Mac indexes, opens Host line jumps through the remote route only', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  const invoke = vi.fn(async (channel: string, path: string) => {
    if (channel !== 'fs:listFiles') throw new Error('No local reads or opens allowed')
    return path.startsWith('host:') ? ['host-only.ts'] : ['mac-only.ts']
  })
  Object.assign(window, { phosphor: { invoke } })
  const host = document.createElement('div'),
    root = createRoot(host)
  document.body.append(host)
  const id = mockRemoteInfo.sessionId
  useSessionsStore.setState({
    activeSessionId: id,
    live: { [id]: { ...mockRemoteInfo, phosphorId: id } },
  })
  try {
    useFinderStore.setState({ open: true })
    await act(async () => root.render(<FuzzyFinder workspacePath="/mac" />))
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('mac-only.ts')
    await act(async () => root.render(<FuzzyFinder workspacePath={mockRemoteInfo.workspacePath} />))
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('host-only.ts')
    expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain('mac-only.ts')
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'host-only.ts:17:3',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    )
    expect(openRemoteFile).toHaveBeenCalledWith(
      id,
      'host-only.ts',
      expect.objectContaining({ line: 17, column: 3 }),
    )
    expect(invoke.mock.calls).toEqual([
      ['fs:listFiles', '/mac'],
      ['fs:listFiles', mockRemoteInfo.workspacePath],
    ])
    await act(async () => {
      useFinderStore.setState({ open: true })
      root.render(<FuzzyFinder workspacePath="/mac" />)
    })
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('mac-only.ts')
    expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain('host-only.ts')
  } finally {
    act(() => root.unmount())
    host.remove()
    useFinderStore.setState({ open: false })
    vi.unstubAllGlobals()
  }
})

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))

function HostHomeFinder(): React.JSX.Element {
  useGlobalShortcuts()
  return <FuzzyFinder workspacePath="/mac" />
}
it('refuses Cmd+P on Host home and drops an already open Mac index on switch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  const invoke = vi.fn().mockResolvedValue(['mac-secret.ts'])
  Object.assign(window, { phosphor: { invoke } })
  const toast = vi.spyOn(useExtensionUiStore.getState(), 'pushToast').mockReturnValue(1)
  useSessionsStore.setState({ activeSessionId: null })
  useWorkspacesStore.setState({ homePath: '/mac' })
  useRemoteLanesStore.setState({ filter: 'local' })
  useFinderStore.setState({ open: true })
  const host = document.createElement('div'),
    root = createRoot(host)
  document.body.append(host)
  try {
    await act(async () => root.render(<HostHomeFinder />))
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('mac-secret.ts')
    invoke.mockClear()
    await act(async () => useRemoteLanesStore.setState({ filter: 'bee1' }))
    expect(document.querySelector('[role="combobox"]')).toBeNull()
    expect(useFinderStore.getState().open).toBe(false)
    expect(toast).toHaveBeenCalledWith('Not available on remote lanes yet.')
    toast.mockClear()
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyP', metaKey: true, bubbles: true }),
      ),
    )
    expect(toast).toHaveBeenCalledWith('Not available on remote lanes yet.')
    expect(document.querySelector('[role="combobox"]')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
