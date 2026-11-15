// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useLaneMoveStore } from '@/stores/laneMove'
import { LaneMoveHost } from './LaneMoveModal'

const remote = vi.hoisted(() => ({ hosts: {} }))
vi.mock('@/stores/remoteLanes', () => ({
  machineLabel: () => 'Host',
  navigateToLane: vi.fn(),
  // Navigation's Desktop fallback subscribes to the store when it loads.
  useRemoteLanesStore: Object.assign((select: (s: unknown) => unknown) => select(remote), {
    subscribe: () => () => {},
    getState: () => remote,
  }),
}))
const folders = vi.hoisted(() => ({
  recents: [{ path: '/target', name: 'Target' }],
  sandboxes: [],
}))
vi.mock('@/stores/workspaces', () => ({
  useWorkspacesStore: (select: (s: unknown) => unknown) => select(folders),
}))
vi.mock('@/stores/sessions', () => ({
  // Navigation's Desktop fallback reads the active lane, which is none here.
  useSessionsStore: Object.assign(
    (select: (s: unknown) => unknown) => select({ activeSessionId: null, live: {} }),
    { getState: vi.fn() },
  ),
}))

let root: Root | undefined
let el: HTMLDivElement | undefined
afterEach(() => {
  if (root) act(() => root!.unmount())
  el?.remove()
  useLaneMoveStore.getState().close()
  vi.unstubAllGlobals()
})

it('recovers from a failed first check and requires acknowledgement before Move', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const invoke = vi.fn().mockRejectedValueOnce(new Error('Connection changed.')).mockResolvedValue({
    mode: 'folder',
    branch: null,
    workspace: 'Target',
    blockers: [],
    bytes: 10,
  })
  vi.stubGlobal('phosphor', { invoke })
  useLaneMoveStore.getState().open({
    source: { machine: 'local', sessionPath: '/source.jsonl' },
    title: 'Research',
    marks: { pinned: false, marker: null },
  })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  await act(async () => root!.render(<LaneMoveHost />))
  const select = document.querySelector('select[aria-label="Workspace"]') as HTMLSelectElement
  await act(async () => {
    select.value = 'local:/target'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(document.body.textContent).toContain('Connection changed.')
  const buttons = () => Array.from(document.querySelectorAll('button'))
  await act(async () =>
    buttons()
      .find((b) => b.textContent === 'Retry check')!
      .click(),
  )
  expect(document.body.textContent).not.toContain('Connection changed.')
  const move = buttons().find((b) => b.textContent === 'Move')!
  expect(move.disabled).toBe(true)
  await act(async () =>
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  )
  expect(move.disabled).toBe(false)
  expect(invoke).toHaveBeenCalledTimes(2)
  // Refreshed Host/workspace snapshots must not repeat an unchanged preflight.
  folders.recents = [...folders.recents]
  await act(async () => root!.render(<LaneMoveHost />))
  expect(invoke).toHaveBeenCalledTimes(2)
})

it('in the browser, moves a Host lane to another Host and opens the copy through navigation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { COMPACT_PLATFORM, PlatformProvider } = await import('@/platform/Platform')
  const { NavigationProvider } = await import('@/navigation/Navigation')
  const ready = (repository: string) => ({
    state: 'ready',
    laneTransfer: true,
    capabilities: ['sessions.read', 'sessions.control', 'workspaces.write'],
    repositories: [{ id: repository, name: `repo-${repository[0]}` }],
    lanes: [],
  })
  remote.hosts = { a: ready('a'.repeat(16)), b: ready('b'.repeat(16)) }
  const laneId = '11111111-2222-4333-8444-555555555555'
  const newLaneId = '66666666-7777-4888-9999-000000000000'
  const invoke = vi.fn(async (channel: string) =>
    channel === 'hosts:laneMovePlan'
      ? { mode: 'folder', branch: null, workspace: 'repo-b', blockers: [], bytes: 3 * 1024 * 1024 }
      : { machine: 'b', laneId: newLaneId },
  )
  vi.stubGlobal('phosphor', { invoke })
  const navigate = vi.fn()
  useLaneMoveStore.getState().open({
    source: { machine: 'a', laneId },
    title: 'Research',
    marks: { pinned: false, marker: null },
  })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  try {
    await act(async () =>
      root!.render(
        <PlatformProvider value={COMPACT_PLATFORM}>
          <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
            <LaneMoveHost />
          </NavigationProvider>
        </PlatformProvider>,
      ),
    )
    const machine = document.querySelector('select[aria-label="Machine"]') as HTMLSelectElement
    expect([...machine.options].map((o) => o.value)).toEqual(['a', 'b'])
    await act(async () => {
      machine.value = 'b'
      machine.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const workspace = document.querySelector('select[aria-label="Workspace"]') as HTMLSelectElement
    await act(async () => {
      workspace.value = `b:${'b'.repeat(16)}`
      workspace.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const target = { machine: 'b', repositoryId: 'b'.repeat(16) }
    expect(invoke).toHaveBeenCalledWith('hosts:laneMovePlan', {
      source: { machine: 'a', laneId },
      target,
      marks: { pinned: false, marker: null },
    })
    expect(document.body.textContent).toContain('3.0 MB to copy.')
    expect(document.body.textContent).toContain('The copy passes through this device')
    await act(async () =>
      (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
    )
    const button = (text: string) =>
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)!
    await act(async () => button('Move').click())
    expect(invoke).toHaveBeenLastCalledWith('hosts:laneMove', {
      source: { machine: 'a', laneId },
      target,
      marks: { pinned: false, marker: null },
    })
    expect(document.body.textContent).toContain('Moved to Host · repo-b.')
    await act(async () => button('Open').click())
    expect(navigate).toHaveBeenCalledWith({
      to: 'lane',
      lane: { hostId: 'b', laneId: newLaneId },
    })
    expect(useLaneMoveStore.getState().draft).toBeNull()
  } finally {
    remote.hosts = {}
  }
})
