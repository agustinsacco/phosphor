// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { FuzzyFinder, useFinderStore } from './FuzzyFinder'
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
