// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteLanes } from './RemoteLanes'
import { RemoteLaneControls } from '@/features/machines/RemoteLaneControls'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useFilesStore } from '@/stores/files'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), filter: 'all' })
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: {
        phosphorId: mockRemoteInfo.sessionId,
        workspacePath: mockRemoteInfo.workspacePath,
        target: mockRemoteInfo.target,
        laneId: mockRemoteInfo.laneId,
      },
    },
  })
  invoke.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('stays dormant without sessions.read and shows unread machine-tagged lanes when enabled', () => {
  act(() => root.render(<RemoteLanes />))
  expect(container.textContent).toContain('Remote demo lane')
  expect(container.querySelector('[aria-label="Unread"]')).not.toBeNull()
  act(() =>
    useRemoteLanesStore.setState({
      hosts: { [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, capabilities: [] } },
    }),
  )
  expect(container.textContent).toBe('')
})

it('keeps offline lanes visible and disabled', () => {
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.state = 'reconnecting'
  useRemoteLanesStore.setState({ hosts })
  act(() => root.render(<RemoteLanes />))
  expect(container.textContent).toContain('is offline')
  expect(container.querySelector<HTMLButtonElement>('[aria-current], button')?.disabled).toBe(true)
})

it('requires explicit takeover and sends the Host identity', async () => {
  act(() => root.render(<RemoteLaneControls sessionId={mockRemoteInfo.sessionId} />))
  expect(container.textContent).toContain('Controlled by Another Desktop')
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click())
  expect(invoke).toHaveBeenCalledWith('hosts:takeControl', MOCK_HOST_ID, mockRemoteInfo.laneId)
})

it('does not open a local file for a remote workspace key', async () => {
  await useFilesStore.getState().openFile(mockRemoteInfo.workspacePath, '/etc/passwd')
  expect(invoke).not.toHaveBeenCalled()
})
