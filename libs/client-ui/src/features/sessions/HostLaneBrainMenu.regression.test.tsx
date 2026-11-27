// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContextMenuHost } from '@/components/ContextMenu'
import { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { mockBrainStatus } from '@/features/brain/mockBrainData'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import type { HostConnectionView } from '@shared/ipc'
import type { BrainAccess } from '@shared/brain-access'
import type { HostBrainLaneState } from '@shared/host-brain'
import type { HostBrainRequest } from '@shared/host-brain-request'
import { RemoteLanes } from './RemoteLanes'

/*
 * A Host lane's menu queues it for Brain directly, as This Mac's menu does. Eligibility
 * is read only once the menu opens, and the write names that Host, connection, lane and
 * Brain version: a switch or revoke after the menu showed refuses it.
 */

const HARBOR = '00000000-0000-4000-8000-0000000000a1'
const LEDGER = '00000000-0000-4000-8000-0000000000a2'
const GENERATION = '7d1f6a52-4a2e-4a7c-9a51-0c1f2b3d4e5f'
const QUEUE = 'Queue for knowledge extraction'

let root: Root
let container: HTMLDivElement
let lane: HostBrainLaneState
let enabled: boolean
let hold: Promise<void> | undefined
const hostInvoke = vi.fn(
  async (_target: { hostId: string; connectionToken: string }, request: HostBrainRequest) => {
    await hold
    switch (request.method) {
      case 'brain:status':
        return status()
      case 'brain:laneState':
        return lane
      case 'brain:queue':
        return status()
      default:
        throw new Error(`Unexpected Brain method ${request.method}`)
    }
  },
)

function status() {
  const { agent, ...base } = mockBrainStatus()
  const { folder: _folder, ...hostAgent } = agent
  return {
    ...base,
    generation: GENERATION,
    revision: 7,
    agent: { ...hostAgent, run: null },
    jobs: [],
    prefs: {
      ...base.prefs,
      enabled,
      neverRead: { titles: ['Kestrel'], sessionIds: [] },
    },
  }
}

function hostView(
  access: BrainAccess[] = ['read', 'configure'],
  token = 'harbor-connection-1',
): HostConnectionView {
  const view = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  view.connectionToken = token
  view.brain = true
  view.brainAccess = access
  const [first] = view.lanes
  view.lanes = [
    { ...first!, laneId: HARBOR, title: 'Harbor billing' },
    { ...first!, laneId: LEDGER, title: 'Ledger sync' },
  ]
  return view
}

function render(view: HostConnectionView, platform = DESKTOP_PLATFORM): void {
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: view }, filter: MOCK_HOST_ID })
  act(() =>
    root.render(
      <PlatformProvider value={platform}>
        <RemoteLanes />
        <ContextMenuHost />
      </PlatformProvider>,
    ),
  )
}

function setHost(view: HostConnectionView): void {
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: view } })
}

async function rightClick(title: string): Promise<void> {
  const row = [...container.querySelectorAll('[data-testid=remote-session-row]')].find((r) =>
    r.textContent?.includes(title),
  )!
  // A mouse right-click: the press, then the menu event.
  const press = new MouseEvent('pointerdown', { bubbles: true, button: 2 })
  Object.defineProperty(press, 'pointerType', { value: 'mouse' })
  await act(async () => {
    row.dispatchEvent(press)
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await act(async () => {})
}

function menuButtons(): HTMLButtonElement[] {
  const menu =
    document.querySelector('[data-testid=context-menu]') ??
    document.querySelector('[data-testid=context-menu-sheet]')
  return menu ? [...menu.querySelectorAll('button')] : []
}
const labels = () => menuButtons().map((b) => b.textContent ?? '')
const button = (label: string) => menuButtons().find((b) => b.textContent === label)

function calls(method: string) {
  return hostInvoke.mock.calls.filter(([, request]) => request.method === method)
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: { invoke: vi.fn().mockResolvedValue(undefined), hostBrain: { invoke: hostInvoke } },
  })
  hostInvoke.mockClear()
  lane = { excluded: false, activeJob: null, lastRead: null }
  enabled = true
  hold = undefined
  useMachinesStore.setState({ remoteEnabled: true })
  useSessionsStore.setState({ live: {}, pinned: [], laneMarkers: {}, bulkDelete: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('right-click queues only that lane, once, on its Host connection at the Brain version it read', async () => {
  render(hostView())
  // Listing lanes reads no Brain state for any row.
  expect(hostInvoke).not.toHaveBeenCalled()
  await rightClick('Harbor billing')
  expect(hostInvoke.mock.calls.map(([target, request]) => [target, request])).toEqual([
    [
      { hostId: MOCK_HOST_ID, connectionToken: 'harbor-connection-1' },
      { method: 'brain:status', args: [] },
    ],
    [
      { hostId: MOCK_HOST_ID, connectionToken: 'harbor-connection-1' },
      { method: 'brain:laneState', args: [HARBOR] },
    ],
  ])
  expect(labels()).toContain(QUEUE)
  expect(labels()).toContain('Brain read…')
  await act(async () => button(QUEUE)!.click())
  expect(calls('brain:queue')).toEqual([
    [
      { hostId: MOCK_HOST_ID, connectionToken: 'harbor-connection-1' },
      {
        method: 'brain:queue',
        args: [HARBOR],
        expected: { generation: GENERATION, revision: 7 },
      },
    ],
  ])
  expect(menuButtons()).toEqual([])
})

it('keeps a clicked queue to one write, and asks again on the next open', async () => {
  render(hostView())
  await rightClick('Harbor billing')
  const queue = button(QUEUE)!
  await act(async () => {
    queue.click()
    queue.click()
  })
  expect(calls('brain:queue')).toHaveLength(1)
  lane = { excluded: false, activeJob: { id: 'job-1', state: 'queued' }, lastRead: null }
  await rightClick('Harbor billing')
  expect(calls('brain:laneState')).toHaveLength(2)
  expect(labels()).not.toContain(QUEUE)
  expect(labels().join(' ')).not.toMatch(/Cancel knowledge extraction/)
})

it('refuses the shown item after the Host connection switches or Brain rights are revoked', async () => {
  render(hostView())
  await rightClick('Harbor billing')
  let queue = button(QUEUE)!
  await act(async () => {
    setHost(hostView(['read', 'configure'], 'harbor-connection-2'))
    queue.click()
  })
  expect(labels()).not.toContain(QUEUE)
  await rightClick('Harbor billing')
  queue = button(QUEUE)!
  await act(async () => {
    setHost(hostView(['read'], 'harbor-connection-2'))
    queue.click()
  })
  expect(calls('brain:queue')).toEqual([])
  await rightClick('Harbor billing')
  expect(labels()).not.toContain(QUEUE)
  expect(labels()).not.toContain('Brain read…')
})

it('drops an eligibility answer that arrives after the Host connection changed', async () => {
  let release!: () => void
  hold = new Promise((resolve) => {
    release = resolve
  })
  render(hostView())
  await rightClick('Harbor billing')
  expect(labels()).toContain('Checking Brain…')
  setHost(hostView(['read', 'configure'], 'harbor-connection-2'))
  await act(async () => release())
  await act(async () => {})
  expect(labels()).not.toContain(QUEUE)
  expect(calls('brain:queue')).toEqual([])
})

it('offers the direct read only where the Host says the lane is eligible', async () => {
  render(hostView(['read']))
  await rightClick('Harbor billing')
  expect(hostInvoke).not.toHaveBeenCalled()
  expect(labels()).not.toContain(QUEUE)

  render(hostView())
  enabled = false
  await rightClick('Harbor billing')
  expect(labels()).not.toContain(QUEUE)

  enabled = true
  lane = { excluded: true, activeJob: null, lastRead: null }
  await rightClick('Harbor billing')
  expect(labels()).not.toContain(QUEUE)
  expect(labels().join(' ')).not.toMatch(/Let Brain read|Never let Brain/)

  lane = { excluded: false, activeJob: null, lastRead: { jobId: 'j', memories: 2, replaceable: 1 } }
  await rightClick('Ledger sync')
  expect(labels()).toContain('Read new messages for Brain')
  expect(labels()).not.toContain('Read again for Brain…')
  await act(async () => button('Read new messages for Brain')!.click())
  expect(calls('brain:queue').map(([, request]) => request.args)).toEqual([[LEDGER]])
})

it('shows a title rule as a refusal, not an action', async () => {
  const view = hostView()
  view.lanes = [{ ...view.lanes[0]!, title: 'Kestrel planning' }, view.lanes[1]!]
  render(view)
  await rightClick('Kestrel planning')
  expect(labels()).not.toContain(QUEUE)
  expect(labels()).toContain('Brain never reads this lane (title rule in Settings › Brain)')
})

it('queues from the compact sheet the same way', async () => {
  render(hostView(), COMPACT_PLATFORM)
  expect(hostInvoke).not.toHaveBeenCalled()
  await rightClick('Harbor billing')
  await act(async () => button(QUEUE)!.click())
  expect(calls('brain:queue')).toEqual([
    [
      { hostId: MOCK_HOST_ID, connectionToken: 'harbor-connection-1' },
      { method: 'brain:queue', args: [HARBOR], expected: { generation: GENERATION, revision: 7 } },
    ],
  ])
})
