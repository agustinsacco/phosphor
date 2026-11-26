// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LiveSessionInfo } from '@shared/models'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { newRoutine, type RoutineRun } from '@shared/routines'
import { noticeHostAttention } from '@/features/sessions/laneNotices'
import { openRun } from '@/features/routines/openRun'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { bindHostsSnapshotRead } from '@/stores/hostsSnapshotRead'
import { useMachinesStore } from '@/stores/machines'
import { openRemoteLane, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { CompactLane } from './CompactLane'
import { useBrowserNavigation } from './useBrowserNavigation'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'

vi.mock('@/features/chat/ChatView', () => ({
  ChatView: () => <div data-testid="chat">transcript</div>,
}))

const laneId = mockRemoteInfo.laneId!
let openLane: ReturnType<typeof makeOpenLane>
const opens: { resolve: (info: LiveSessionInfo) => void; reject: (error: Error) => void }[] = []
let root: Root | undefined
let fake: ReturnType<typeof createFakePhosphor>
let restore: () => void
let readBootstrap: () => Promise<void>

function makeOpenLane() {
  return vi.fn(
    (_host: string, _lane: string) =>
      new Promise<LiveSessionInfo>((resolve, reject) => opens.push({ resolve, reject })),
  )
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  readBootstrap = async () => undefined
  openLane = makeOpenLane()
  fake = createFakePhosphor({
    'hosts:openLane': openLane,
    'hosts:snapshot': () => useRemoteLanesStore.getState().hosts,
    'hosts:markRead': () => undefined,
    'pi:command': async (_id, command) => {
      if (command.type === 'get_state') await readBootstrap()
      if (command.type === 'get_messages')
        return { type: 'response', command: command.type, success: true, data: { messages: [] } }
      return { type: 'response', command: command.type, success: false, error: 'not available' }
    },
  })
  restore = installFakePhosphor(fake)
  useLayoutStore.setState({ page: null })
  useSessionsStore.setState({ live: {}, activeSessionId: null, opening: null })
  useRemoteLanesStore.setState({
    hosts: structuredClone(mockRemoteHosts),
    snapshotStatus: 'ready',
    filter: MOCK_HOST_ID,
  })
})
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    useSessionsStore.getState().claimNav()
    for (const open of opens.splice(0)) open.reject(new Error('test ended'))
  })
  document.body.innerHTML = ''
  fake.dispose()
  restore()
  vi.unstubAllGlobals()
})

const lanePath = (host: string, lane: string) => `/lanes/${host}/${lane}/chat`

function RoutedLane(): React.JSX.Element | null {
  const { location, navigate, pending } = useBrowserNavigation()
  if (pending || location.to !== 'lane' || !('hostId' in location.lane)) return null
  return (
    <CompactLane
      key={`${location.lane.hostId}:${location.lane.laneId}`}
      location={location}
      navigate={navigate}
    />
  )
}

async function renderRoute(path: string): Promise<HTMLElement> {
  useMachinesStore.setState({ remoteEnabled: true })
  useExtensionUiStore.setState({ toasts: [] })
  window.history.replaceState(null, '', path)
  const el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  await act(async () => root!.render(<RoutedLane />))
  return el
}

const routineRun: RoutineRun = {
  id: `host:${MOCK_HOST_ID}/run`,
  outputLaneId: laneId,
  routineId: 'routine',
  trigger: 'schedule',
  scheduledAt: 0,
  createdAt: 0,
  startedAt: 0,
  endedAt: 1,
  status: 'finished',
  reason: '',
  definition: {
    ...newRoutine('/remote/demo'),
    id: 'routine',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    nextAt: null,
    attention: null,
    archived: false,
  },
  sessionId: null,
  sessionPath: null,
  workspacePath: null,
  branch: null,
  baseCommit: null,
  accountId: null,
  summary: '',
}

it('Continue from Routines keeps a cold open on its lane URL instead of returning Home', async () => {
  const el = await renderRoute(`/pages/routines/${MOCK_HOST_ID}`)
  expect(useLayoutStore.getState().page).toBe('routines')
  let continuing!: Promise<unknown>
  await act(async () => {
    continuing = openRun(routineRun).catch((error: unknown) => error)
  })
  const whileOpening = window.location.pathname
  const busy = el.querySelector('[data-testid="opening-lane"]')?.getAttribute('aria-busy')
  expect(opens).toHaveLength(1)
  await act(async () => opens[0]!.resolve(mockRemoteInfo))
  await expect(continuing).resolves.toBeUndefined()
  expect(whileOpening).toBe(lanePath(MOCK_HOST_ID, laneId))
  expect(window.location.pathname).toBe(whileOpening)
  expect(busy).toBe('true')
  expect(el.querySelector('[data-testid="chat"]')).not.toBeNull()
})

it('leaving the old Host lane does not clear a newer open on another Host', async () => {
  const nextHost = 'next-host'
  useRemoteLanesStore.setState((s) => ({
    hosts: { ...s.hosts, [nextHost]: structuredClone(s.hosts[MOCK_HOST_ID]!) },
  }))
  const el = await renderRoute(lanePath(MOCK_HOST_ID, laneId))
  let opened!: Promise<boolean>
  await act(async () => {
    opened = openRemoteLane(nextHost, laneId)
  })
  expect(opens).toHaveLength(2)
  const next = {
    ...mockRemoteInfo,
    sessionId: 'next-session',
    target: { kind: 'remote' as const, hostId: nextHost },
  }
  await act(async () => {
    opens[0]!.resolve(mockRemoteInfo)
    opens[1]!.resolve(next)
  })
  expect(await opened).toBe(true)
  expect(window.location.pathname).toBe(lanePath(nextHost, laneId))
  expect(el.querySelector('[data-testid="chat"]')).not.toBeNull()
})

it('a second failed notice open on the same Host shows that lane and its Retry', async () => {
  const second = 'second-lane'
  const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
  host.lanes.push({ ...host.lanes[0]!, laneId: second, title: 'Second lane' })
  const el = await renderRoute(lanePath(MOCK_HOST_ID, laneId))
  await act(async () => opens[0]!.reject(new Error('first failure')))
  expect(el.querySelector('[role="alert"]')?.textContent).toBe('Could not open the remote lane.')
  noticeHostAttention(
    { hostId: MOCK_HOST_ID, laneId: second, title: 'Second lane', kind: 'finished', at: '' },
    undefined,
    () => openRemoteLane(MOCK_HOST_ID, second),
  )
  const notice = useExtensionUiStore.getState().toasts.find((toast) => toast.onOpen)!
  await act(async () => {
    const opened = notice.onOpen!()
    opens[1]!.reject(new Error('second failure'))
    await opened
  })
  expect(window.location.pathname).toBe(lanePath(MOCK_HOST_ID, second))
  expect(el.querySelector('[data-testid="opening-lane"]')?.textContent).toContain('Second lane')
  expect(el.querySelector('[role="alert"]')?.textContent).toBe('Could not open the remote lane.')
  const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
  await act(async () => retry.click())
  expect(openLane).toHaveBeenLastCalledWith(MOCK_HOST_ID, second)
  await act(async () => opens[2]!.reject(new Error('retry failure')))
})

it('keeps the browser busy after live is published and until the snapshot refresh lands', async () => {
  let finishBootstrap!: () => void
  const bootstrap = new Promise<void>((resolve) => (finishBootstrap = resolve))
  readBootstrap = () => bootstrap
  let finishSnapshot!: () => void
  const snapshot = new Promise<void>((resolve) => (finishSnapshot = resolve))
  const refresh = vi.fn(() => snapshot)
  bindHostsSnapshotRead(refresh)
  useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.warmOnOpen = true
  try {
    const el = await renderRoute(lanePath(MOCK_HOST_ID, laneId))
    const busy = () => el.querySelector('[data-testid="opening-lane"]')?.getAttribute('aria-busy')
    await act(async () => opens[0]!.resolve(mockRemoteInfo))
    expect(useSessionsStore.getState().live[mockRemoteInfo.sessionId]).toBeDefined()
    const duringBootstrap = busy()
    await act(async () => finishBootstrap())
    expect(refresh).toHaveBeenCalledTimes(1)
    const duringSnapshot = busy()
    await act(async () => finishSnapshot())
    expect(duringBootstrap).toBe('true')
    expect(duringSnapshot).toBe('true')
    expect(el.querySelector('[data-testid="chat"]')).not.toBeNull()
  } finally {
    bindHostsSnapshotRead(async () => undefined)
  }
})
