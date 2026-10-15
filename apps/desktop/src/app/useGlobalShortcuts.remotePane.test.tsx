// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RightPane } from '@/features/files/RightPane'
import { useGlobalShortcuts } from './useGlobalShortcuts'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteInfo, mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/features/terminal/TerminalPane', () => ({ TerminalPane: () => null }))
vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoEditor: () => null,
  MonacoDiff: () => null,
}))
function RemotePane(): React.JSX.Element {
  useGlobalShortcuts()
  return (
    <>
      <textarea data-composer-input />
      <RightPane
        sessionId={mockRemoteInfo.sessionId}
        workspacePath={mockRemoteInfo.workspacePath}
      />
    </>
  )
}
it('F6 enters the real remote Files pane, returns to composer, and focuses fullscreen exit', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.assign(window, { phosphor: { invoke: vi.fn().mockResolvedValue([]) } })
  const id = mockRemoteInfo.sessionId
  useSessionsStore.setState({
    activeSessionId: id,
    live: { [id]: { ...mockRemoteInfo, phosphorId: id } },
  })
  useRemoteLanesStore.setState({ hosts: mockRemoteHosts, filter: MOCK_HOST_ID })
  useLayoutStore.getState().setRightPane('files', id)
  const container = document.createElement('div'),
    root = createRoot(container)
  document.body.append(container)
  const f6 = () =>
    act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'F6', bubbles: true }),
      ),
    )
  try {
    await act(async () => root.render(<RemotePane />))
    const composer = container.querySelector('textarea')!
    composer.focus()
    f6()
    expect(
      container.querySelector('[data-testid="right-pane"]')?.contains(document.activeElement),
    ).toBe(true)
    f6()
    expect(document.activeElement).toBe(composer)
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Fullscreen pane"]')!.click(),
    )
    composer.focus()
    f6()
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Exit fullscreen"]'))
    f6()
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Exit fullscreen"]'))
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
