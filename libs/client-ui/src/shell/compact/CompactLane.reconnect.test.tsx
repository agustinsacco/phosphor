// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import type { HostConnectionView } from '@phosphor/shared/ipc'
import { CompactLane } from './CompactLane'

vi.mock('@/features/chat/ChatView', () => ({
  ChatView: () => <div data-testid="chat">transcript</div>,
}))
vi.mock('@/stores/remoteLanes', async (original) => ({
  ...(await original<object>()),
  openRemoteLane: vi.fn(async () => true),
}))

const laneId = mockRemoteInfo.laneId!
const host = mockRemoteHosts[MOCK_HOST_ID]!
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  useRemoteLanesStore.setState({ hosts: {}, snapshotStatus: 'idle', filter: 'local' })
  useSessionsStore.setState({ live: {} })
})

async function render(state: HostConnectionView['state'], open: boolean): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useMachinesStore.setState({ machines: [{ id: MOCK_HOST_ID, label: 'Studio' }] as never })
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...host, state } },
    snapshotStatus: 'ready',
    filter: MOCK_HOST_ID,
  })
  if (open)
    useSessionsStore.setState({
      live: {
        [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
      } as never,
    })
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

const setState = (state: HostConnectionView['state']) =>
  act(async () => useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...host, state } } }))

// The composer inside the lane says it is reconnecting (Composer.renders.test.tsx).
it('keeps an open lane on screen while its Host reconnects', async () => {
  const el = await render('ready', true)
  const chat = el.querySelector('[data-testid="chat"]')
  expect(chat).not.toBeNull()
  for (const state of ['reconnecting', 'connecting'] as const) {
    await setState(state)
    expect(el.querySelector('[data-testid="chat"]')).toBe(chat)
    expect(el.textContent).not.toContain('Open Machines to reconnect')
  }
  await setState('ready')
  expect(el.querySelector('[data-testid="chat"]')).toBe(chat)
  // A Host that is down needs the user: the lane gives way to the instruction.
  await setState('down')
  expect(el.textContent).toBe('Machine not connected. Open Machines to reconnect.')
  expect(el.querySelector('[aria-busy="true"]')).toBeNull()
})

it('says it is reconnecting, not that the machine is gone, before a lane has opened', async () => {
  const el = await render('reconnecting', false)
  const busy = el.querySelector('[role="status"][aria-busy="true"]')
  expect(busy?.querySelector('h1')?.textContent).toBe('Reconnecting to Studio…')
  await setState('connecting')
  expect(busy?.querySelector('h1')?.textContent).toBe('Connecting to Studio…')
  await setState('down')
  expect(el.textContent).toBe('Machine not connected. Open Machines to reconnect.')
  expect(el.querySelector('[aria-busy="true"]')).toBeNull()
})
