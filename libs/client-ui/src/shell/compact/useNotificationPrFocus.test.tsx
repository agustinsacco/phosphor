// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import type { Location } from '@/navigation/location'
import { useSessionsStore } from '@/stores/sessions'
import { usePrInspectorStore } from '@/stores/prInspector'
import { useNotificationPrFocus } from './useNotificationPrFocus'

const pr = { host: 'github.com', owner: 'Acme', repo: 'app', number: 57 }
const laneId = mockRemoteInfo.laneId!
const location: Location = { to: 'lane', lane: { hostId: MOCK_HOST_ID, laneId }, pane: 'chat' }
const path = `/lanes/${MOCK_HOST_ID}/${laneId}/chat`
let root: Root
let container: HTMLDivElement
function Consumer() {
  useNotificationPrFocus()
  return null
}
function mount(next = location) {
  act(() =>
    root.render(
      <NavigationProvider value={{ location: next, navigate: vi.fn() }}>
        <Consumer />
      </NavigationProvider>,
    ),
  )
}
function query(value: string) {
  window.history.replaceState(
    null,
    '',
    `${path}?keep=1&notificationPr=${encodeURIComponent(value)}#end`,
  )
}
function activate(hostId = MOCK_HOST_ID, id = laneId) {
  useSessionsStore.setState({
    activeSessionId: mockRemoteInfo.sessionId,
    live: {
      [mockRemoteInfo.sessionId]: {
        ...mockRemoteInfo,
        phosphorId: mockRemoteInfo.sessionId,
        target: { kind: 'remote', hostId },
        laneId: id,
      },
    },
  })
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  usePrInspectorStore.setState({ request: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  usePrInspectorStore.setState({ request: null })
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})
it('waits for this Host lane to be active, consumes PR focus once and preserves other URL parts', () => {
  query(JSON.stringify(pr))
  mount()
  expect(usePrInspectorStore.getState().request).toBeNull()
  expect(window.location.search).toContain('notificationPr=')
  act(() => activate('another-host'))
  expect(usePrInspectorStore.getState().request).toBeNull()
  act(() => activate(MOCK_HOST_ID, 'another-lane'))
  expect(usePrInspectorStore.getState().request).toBeNull()
  expect(window.location.search).toContain('notificationPr=')
  act(() => activate())
  expect(usePrInspectorStore.getState().request).toMatchObject({
    sessionId: mockRemoteInfo.sessionId,
    key: 'github.com/acme/app#57',
  })
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(
    `${path}?keep=1#end`,
  )
  usePrInspectorStore.setState({ request: null })
  act(() => activate())
  expect(usePrInspectorStore.getState().request).toBeNull()
})
it.each([
  'bad JSON',
  JSON.stringify({ ...pr, number: 0 }),
  JSON.stringify({ ...pr, path: '/private' }),
])('strips malformed PR focus without opening an inspector: %s', (raw) => {
  query(raw)
  activate()
  mount()
  expect(usePrInspectorStore.getState().request).toBeNull()
  expect(window.location.search).toBe('?keep=1')
})
it('does not consume lane focus while another screen is showing', () => {
  query(JSON.stringify(pr))
  activate()
  mount({ to: 'page', page: 'settings' })
  expect(usePrInspectorStore.getState().request).toBeNull()
  expect(window.location.search).toContain('notificationPr=')
})
