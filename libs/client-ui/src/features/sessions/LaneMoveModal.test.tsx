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
  remote.hosts = {}
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

const laneId = '11111111-2222-4333-8444-555555555555'
const newLaneId = '66666666-7777-4888-9999-000000000000'
const hostB = { machine: 'b', repositoryId: 'b'.repeat(16) }
const hostReady = (repository: string) => ({
  state: 'ready',
  laneTransfer: true,
  capabilities: ['sessions.read', 'sessions.control', 'workspaces.write'],
  repositories: [{ id: repository, name: `repo-${repository[0]}` }],
  lanes: [],
})
const button = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)!

/** The dialog for Host a's lane, rendered in `tree`, with Host b's folder picked. */
async function pickHostB(tree: React.JSX.Element) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  remote.hosts = { a: hostReady('a'.repeat(16)), b: hostReady('b'.repeat(16)) }
  const invoke = vi.fn(async (channel: string) =>
    channel === 'hosts:laneMovePlan'
      ? { mode: 'folder', branch: null, workspace: 'repo-b', blockers: [], bytes: 3 * 1024 * 1024 }
      : { machine: 'b', laneId: newLaneId },
  )
  vi.stubGlobal('phosphor', { invoke })
  useLaneMoveStore.getState().open({
    source: { machine: 'a', laneId },
    title: 'Research',
    marks: { pinned: false, marker: null },
  })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  await act(async () => root!.render(tree))
  const machine = document.querySelector('select[aria-label="Machine"]') as HTMLSelectElement
  const machines = [...machine.options].map((o) => o.value)
  await act(async () => {
    machine.value = 'b'
    machine.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const workspace = document.querySelector('select[aria-label="Workspace"]') as HTMLSelectElement
  await act(async () => {
    workspace.value = `b:${'b'.repeat(16)}`
    workspace.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(invoke).toHaveBeenCalledWith('hosts:laneMovePlan', {
    source: { machine: 'a', laneId },
    target: hostB,
    marks: { pinned: false, marker: null },
  })
  expect(document.body.textContent).toContain('3.0 MB to copy.')
  return { invoke, machines }
}

/** Accepts the target's setup and moves, which lands on Host b. */
async function acceptAndMove(invoke: ReturnType<typeof vi.fn>) {
  await act(async () =>
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  )
  await act(async () => button('Move').click())
  expect(invoke).toHaveBeenLastCalledWith('hosts:laneMove', {
    source: { machine: 'a', laneId },
    target: hostB,
    marks: { pinned: false, marker: null },
  })
  expect(document.body.textContent).toContain('Moved to Host · repo-b.')
}

it('on Desktop, moves between Hosts without the memory note and waits for the copy to open', async () => {
  const { navigateToLane } = await import('@/stores/remoteLanes')
  const { invoke, machines } = await pickHostB(<LaneMoveHost />)
  expect(machines).toEqual(['local', 'a', 'b'])
  // Desktop stages the bundle in a private temp file: the dialog keeps its old wording.
  expect(document.body.textContent).not.toContain('passes through this device')
  await acceptAndMove(invoke)
  let opened!: (value: boolean) => void
  vi.mocked(navigateToLane)
    .mockClear()
    .mockReturnValueOnce(new Promise((resolve) => (opened = resolve)))
  await act(async () => button('Open').click())
  expect(navigateToLane).toHaveBeenCalledWith({ hostId: 'b', laneId: newLaneId })
  // The Host lane is still opening: the dialog stays until it has.
  expect(useLaneMoveStore.getState().draft).not.toBeNull()
  expect(document.body.textContent).toContain('Moved to Host · repo-b.')
  await act(async () => opened(true))
  expect(useLaneMoveStore.getState().draft).toBeNull()
})

it('in the browser, moves a Host lane to another Host and opens the copy through navigation', async () => {
  const { COMPACT_PLATFORM, PlatformProvider } = await import('@/platform/Platform')
  const { NavigationProvider } = await import('@/navigation/Navigation')
  const navigate = vi.fn()
  const { invoke, machines } = await pickHostB(
    <PlatformProvider value={COMPACT_PLATFORM}>
      <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
        <LaneMoveHost />
      </NavigationProvider>
    </PlatformProvider>,
  )
  expect(machines).toEqual(['a', 'b'])
  expect(document.body.textContent).toContain('The copy passes through this device')
  await acceptAndMove(invoke)
  await act(async () => button('Open').click())
  expect(navigate).toHaveBeenCalledWith({
    to: 'lane',
    lane: { hostId: 'b', laneId: newLaneId },
  })
  expect(useLaneMoveStore.getState().draft).toBeNull()
})

const taken = 'A branch named agustin/arena already exists in Target.'
const plan = (blockers: string[] = []) => ({
  mode: 'new-branch',
  branch: 'agustin/arena',
  workspace: 'Target',
  blockers,
  bytes: 10,
})
const checkbox = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')
const move = () => button('Move')
const checks = (invoke: ReturnType<typeof vi.fn>) =>
  invoke.mock.calls.filter(([channel]) => channel === 'hosts:laneMovePlan').length

/** Open the dialog, choose Target, wait for its check and acknowledge it. */
async function acknowledgeMove(invoke: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke })
  useLaneMoveStore.getState().open({
    source: { machine: 'local', sessionPath: '/source.jsonl' },
    title: 'Arena',
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
  await act(async () => checkbox()!.click())
  expect(move().disabled).toBe(false)
}

it('checks again after a refused Move, so the same stale plan cannot be retried', async () => {
  const answers = [plan(), plan([taken])]
  const invoke = vi.fn((channel: string) =>
    Promise.resolve(channel === 'hosts:laneMove' ? { blockers: [taken] } : answers.shift()),
  )
  await acknowledgeMove(invoke)
  await act(async () => move().click())
  expect(checks(invoke)).toBe(2)
  expect(move().disabled).toBe(true)
  expect(checkbox()).toBeNull()
  // The refusal and the fresh check's blocker are one message, shown once.
  expect(document.body.textContent!.split(taken)).toHaveLength(2)
})

it('asks for a fresh acknowledgement after a failed Move even when the new check passes', async () => {
  const invoke = vi.fn((channel: string) =>
    channel === 'hosts:laneMove'
      ? Promise.reject(new Error('Connection changed.'))
      : Promise.resolve(plan()),
  )
  await acknowledgeMove(invoke)
  await act(async () => move().click())
  expect(document.body.textContent).toContain('Connection changed.')
  expect(checks(invoke)).toBe(2)
  expect(checkbox()!.checked).toBe(false)
  expect(move().disabled).toBe(true)
  await act(async () => checkbox()!.click())
  expect(move().disabled).toBe(false)
  expect(invoke.mock.calls.filter(([channel]) => channel === 'hosts:laneMove')).toHaveLength(1)
})
