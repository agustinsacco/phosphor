// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useLaneCreatesStore, type LaneCreate } from '@/stores/laneCreates'
import { homeDraftKey, useDraftsStore, clearDraftMemory } from '@/stores/drafts'
import { CompactNew } from '@/shell/compact/CompactNew'
import { OpeningLane } from './OpeningLane'
import { LaneCreateRows } from './LaneCreateRows'

vi.mock('@/lib/monaco', () => ({}))

const REPO = '0000000000000001'
const key = homeDraftKey(`host:${MOCK_HOST_ID}/machine`)
let root: Root, container: HTMLDivElement
const navigate = vi.fn()
const create: LaneCreate = {
  id: 'create-1',
  hostId: MOCK_HOST_ID,
  repositoryId: REPO,
  draftKey: key,
  title: 'Fix the parser',
  text: 'Fix the parser',
  attachments: [],
  swarm: false,
  branches: [],
  seen: [],
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    invoke: vi.fn(() => new Promise(() => {})),
    piCommand: vi.fn(),
    onSessionPush: () => () => {},
  })
  navigate.mockReset()
  clearDraftMemory()
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), filter: MOCK_HOST_ID })
  useSessionsStore.setState({ live: {}, activeSessionId: null, navSeq: 1, opening: null })
  useLaneCreatesStore.setState({ creates: { [create.id]: create } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(node: React.ReactNode): void {
  act(() =>
    root.render(
      <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
        {node}
      </NavigationProvider>,
    ),
  )
}

it('lists a starting placeholder row at the top of its folder and selects it on click', () => {
  render(<LaneCreateRows hostId={MOCK_HOST_ID} repositoryId={REPO} />)
  const row = container.querySelector<HTMLButtonElement>('[data-testid="lane-create-row"]')!
  expect(row.textContent).toContain('Fix the parser')
  expect(row.getAttribute('data-activity')).toBe('starting')
  act(() => row.click())
  expect(navigate).toHaveBeenCalledWith({ to: 'new', machine: MOCK_HOST_ID, create: 'create-1' })
})

it('shows the sent message with the loader while the lane starts', () => {
  render(<OpeningLane lane={{ title: create.title, reason: 'open', create: create.id }} />)
  expect(container.querySelector('[data-testid="starting-chat-message"]')?.textContent).toBe(
    'Fix the parser',
  )
  expect(container.querySelector('[data-testid="opening-lane"]')?.getAttribute('aria-busy')).toBe(
    'true',
  )
})

it('says why a create failed, with Edit and retry and Dismiss', () => {
  useLaneCreatesStore.setState({
    creates: { [create.id]: { ...create, failure: 'At its limit.' } },
  })
  render(<OpeningLane lane={{ title: create.title, reason: 'open', create: create.id }} />)
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('At its limit.')
  const edit = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Edit and retry',
  )!
  act(() => edit.click())
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('Fix the parser')
  expect(navigate).toHaveBeenCalledWith({ to: 'new', machine: MOCK_HOST_ID })
  expect(useLaneCreatesStore.getState().creates).toEqual({})
})

it('the browser shows the same placeholder view on its New route', () => {
  render(<CompactNew hostId={MOCK_HOST_ID} create="create-1" />)
  expect(container.querySelector('[data-testid="starting-chat-message"]')?.textContent).toBe(
    'Fix the parser',
  )
})

it('the browser shows another machine’s placeholder only on its own machine', () => {
  render(<CompactNew hostId="another-host" create="create-1" />)
  expect(container.querySelector('[data-testid="starting-chat-message"]')).toBeNull()
})

it('says it is checking with the Host while an uncertain create may still land', () => {
  useLaneCreatesStore.setState({
    creates: { [create.id]: { ...create, unknown: true, checking: true } },
  })
  render(<OpeningLane lane={{ title: create.title, reason: 'open', create: create.id }} />)
  expect(container.textContent).toContain('Checking with the Host…')
  expect([...container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
    'Edit and retry',
  )
})
