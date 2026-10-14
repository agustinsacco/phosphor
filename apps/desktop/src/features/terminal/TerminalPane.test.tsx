// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useTerminalStore } from '@/stores/terminal'
import { TerminalPane } from './TerminalPane'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./TerminalView', () => ({
  TerminalView: ({ readOnly }: { readOnly: boolean }) => <div data-readonly={String(readOnly)} />,
}))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.phosphor = { ...window.phosphor, invoke }
  invoke.mockReset().mockResolvedValue({ ptyId: 'remote-pty-test' })
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
    },
  })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts) })
  useTerminalStore.setState({ bySession: {}, pendingPaste: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const render = async () => {
  await act(async () => {
    root.render(
      <TerminalPane
        sessionId={mockRemoteInfo.sessionId}
        workspacePath={mockRemoteInfo.workspacePath}
      />,
    )
  })
}
it('viewer shows the read-only hint, never auto-creates, and disables input on viewed tabs', async () => {
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]?.capabilities.push('terminal')
  useRemoteLanesStore.setState({ hosts })
  await render()
  expect(container.textContent).toContain('Read-only. Take control to send messages.')
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => {
    await useTerminalStore
      .getState()
      .createTab(mockRemoteInfo.sessionId, mockRemoteInfo.workspacePath)
  })
  await act(async () => {
    await useTerminalStore
      .getState()
      .createTab(mockRemoteInfo.sessionId, mockRemoteInfo.workspacePath)
  })
  expect(useTerminalStore.getState().bySession[mockRemoteInfo.sessionId]?.tabs).toHaveLength(1)
  expect(container.querySelector('[data-readonly="true"]')).not.toBeNull()
})
it('missing capability retains the unavailable state without starting a local shell', async () => {
  await render()
  expect(container.textContent).toContain('Not available on remote lanes yet.')
  expect(container.textContent).not.toContain('Starting shell')
  expect(invoke).not.toHaveBeenCalled()
})

it('viewer empty list failure shows the fixed message without an automatic retry', async () => {
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]?.capabilities.push('terminal')
  useRemoteLanesStore.setState({ hosts })
  invoke.mockRejectedValue(new Error('Read-only: no terminals available.'))
  await render()
  await act(async () => {
    await useTerminalStore
      .getState()
      .createTab(mockRemoteInfo.sessionId, mockRemoteInfo.workspacePath)
  })
  expect(container.textContent).toContain('Read-only: no terminals available.')
  expect(container.textContent).toContain('Read-only. Take control to send messages.')
  expect(container.textContent).not.toContain('Retry')
  expect(invoke).toHaveBeenCalledTimes(1)
})
