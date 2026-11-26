// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { remoteLaneKey } from '@shared/remote-host'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore, type OpeningLane as OpeningLaneState } from '@/stores/sessions'
import { OpeningLane } from './OpeningLane'
import { RemoteLaneList } from './RemoteLaneList'

vi.mock('@/lib/monaco', () => ({}))

const LANE = mockRemoteInfo.laneId ?? ''
let root: Root, container: HTMLDivElement
const invoke = vi.fn()
const opening: OpeningLaneState = {
  workspacePath: remoteLaneKey(MOCK_HOST_ID, LANE),
  title: 'Fix the parser',
  reason: 'open',
  nav: 1,
  lane: { hostId: MOCK_HOST_ID, laneId: LANE },
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockReset().mockReturnValue(new Promise(() => {}))
  vi.stubGlobal('phosphor', { invoke, piCommand: vi.fn(), onSessionPush: () => () => {} })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), filter: MOCK_HOST_ID })
  useSessionsStore.setState({ live: {}, activeSessionId: null, opening: null, navSeq: 1 })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('shows the Phosphor loader and the lane it is opening', () => {
  act(() => root.render(<OpeningLane lane={opening} />))
  const view = container.querySelector('[data-testid="opening-lane"]')!
  expect(view.getAttribute('aria-busy')).toBe('true')
  expect(view.textContent).toContain('Opening')
  expect(view.textContent).toContain('Fix the parser')
  expect(view.querySelector('svg')).not.toBeNull()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('a failed open says why and Retry opens the lane again, never leaving the loader up', () => {
  act(() => root.render(<OpeningLane lane={{ ...opening, failure: 'Could not open the remote lane.' }} />))
  const view = container.querySelector('[data-testid="opening-lane"]')!
  expect(view.getAttribute('aria-busy')).toBe('false')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not open the remote lane.',
  )
  const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
  act(() => retry.click())
  expect(invoke).toHaveBeenCalledWith('hosts:openLane', MOCK_HOST_ID, LANE)
  expect(useSessionsStore.getState().opening?.failure).toBeUndefined()
})

it('selects the row being opened and marks it opening while its open runs', () => {
  const lanes = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.lanes
  act(() =>
    // Desktop's navigation; the browser's routes to `CompactLane`, which opens through the same call.
    root.render(<RemoteLaneList hostId={MOCK_HOST_ID} lanes={lanes} ready />),
  )
  const row = container.querySelector('[data-testid="remote-session-row"]')!
  act(() => (row as HTMLElement).click())
  expect(invoke).toHaveBeenCalledWith('hosts:openLane', MOCK_HOST_ID, LANE)
  expect(row.getAttribute('aria-current')).toBe('page')
  expect(row.getAttribute('data-activity')).toBe('opening')
  // Clicking away keeps the background open visible on its row, without selecting it.
  act(() => useSessionsStore.getState().activate(null))
  expect(row.getAttribute('aria-current')).toBeNull()
  expect(row.getAttribute('data-activity')).toBe('opening')
})
