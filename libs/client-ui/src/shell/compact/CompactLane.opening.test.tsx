// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LiveSessionInfo } from '@shared/models'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { CompactLane } from './CompactLane'

vi.mock('@/features/chat/ChatView', () => ({
  ChatView: () => <div data-testid="chat">transcript</div>,
}))

const laneId = mockRemoteInfo.laneId!
const invoke = vi.fn()
let opens: { resolve: (info: LiveSessionInfo) => void; reject: (error: Error) => void }[] = []
let root: Root | undefined

beforeEach(() => {
  opens = []
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  invoke.mockReset().mockImplementation((channel: string) =>
    channel === 'hosts:openLane'
      ? new Promise((resolve, reject) => opens.push({ resolve, reject }))
      : channel === 'hosts:snapshot'
        ? Promise.resolve(structuredClone(mockRemoteHosts))
        : Promise.resolve([]),
  )
  vi.stubGlobal('phosphor', {
    invoke,
    onSessionPush: () => () => {},
    piCommand: vi.fn(async () => ({ success: true, data: { messages: [] } })),
  })
  useLayoutStore.setState({ page: null })
  useSessionsStore.setState({ live: {}, activeSessionId: null, opening: null })
  useRemoteLanesStore.setState({
    hosts: structuredClone(mockRemoteHosts),
    snapshotStatus: 'ready',
    filter: MOCK_HOST_ID,
  })
})
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(): Promise<HTMLElement> {
  const el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  await act(async () =>
    root!.render(
      <CompactLane
        location={{ to: 'lane', lane: { hostId: MOCK_HOST_ID, laneId }, pane: 'chat' }}
        navigate={() => {}}
      />,
    ),
  )
  return el
}

it('the browser shows the same opening view as Desktop, then the lane', async () => {
  const el = await render()
  const view = el.querySelector('[data-testid="opening-lane"]')
  expect(view?.getAttribute('aria-busy')).toBe('true')
  expect(view?.textContent).toContain('Opening')
  await vi.waitFor(() => expect(opens).toHaveLength(1))
  await act(async () => opens[0]!.resolve(mockRemoteInfo))
  await vi.waitFor(() => expect(el.querySelector('[data-testid="chat"]')).not.toBeNull())
  expect(el.querySelector('[data-testid="opening-lane"]')).toBeNull()
})

it('a failed open shows its reason and Retry in the same view, opening again', async () => {
  const el = await render()
  await vi.waitFor(() => expect(opens).toHaveLength(1))
  await act(async () => opens[0]!.reject(new Error('down')))
  await vi.waitFor(() =>
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not open the remote lane.',
    ),
  )
  expect(el.querySelector('[data-testid="opening-lane"]')?.getAttribute('aria-busy')).toBe('false')
  const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
  await act(async () => retry.click())
  await vi.waitFor(() => expect(opens).toHaveLength(2))
  expect(el.querySelector('[data-testid="opening-lane"]')?.getAttribute('aria-busy')).toBe('true')
})
