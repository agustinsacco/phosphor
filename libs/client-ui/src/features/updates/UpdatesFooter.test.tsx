// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionView } from '@shared/ipc'
import type { UpdateState } from '@shared/models'
import { NavigationProvider } from '@/navigation/Navigation'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  PlatformProvider,
  type Platform,
} from '@/platform/Platform'
import { useMachinesStore } from '@/stores/machines'
import { useMachineUpdatesStore } from '@/stores/machineUpdates'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { reportedRun } from './machineUpdateFacts'
import { trackReady, type MachineUpdateEntry, type UpdateRun } from './machineUpdateState'
import { useUpdatesStore } from './updatesStore'
import { UpdatesFooter } from './UpdatesFooter'

const host = (over: Partial<HostConnectionView> = {}): HostConnectionView => ({
  state: 'ready',
  hostVersion: '1.2.0',
  connectionToken: '1',
  ops: true,
  capabilities: ['sessions.read', 'sessions.control'],
  repositories: [],
  lanes: [],
  ...over,
})
const available: MachineUpdateEntry = {
  version: '1.2.0',
  status: { pause: { kind: 'none' }, update: { supported: true, available: '1.3.0' } },
}
const run = (over: Partial<UpdateRun>): UpdateRun => ({
  path: 'op',
  started: 1,
  shownAt: 0,
  step: 'downloading',
  reached: 'downloading',
  from: '1.2.0',
  ...over,
})

let root: Root
let container: HTMLDivElement
let stopReadiness: () => void = () => {}
const navigate = vi.fn()

/** What the shell's update observer does on a connection change: each machine's readiness. */
function observeReadiness() {
  const apply = () =>
    useMachineUpdatesStore.setState((s) => {
      const hosts = useRemoteLanesStore.getState().hosts
      const byMachine = { ...s.byMachine }
      for (const id of new Set([...Object.keys(hosts), ...Object.keys(byMachine)]))
        byMachine[id] = trackReady(byMachine[id] ?? {}, hosts[id], Date.now())
      return { byMachine }
    })
  apply()
  return useRemoteLanesStore.subscribe(apply)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: {
      platform: 'darwin',
      invoke: vi.fn(async () => undefined),
      onUpdateEvent: () => () => {},
    },
  })
  navigate.mockReset()
  useUpdatesStore.setState({ update: { phase: 'idle' }, acting: false })
  // The shell's update observer starts with the app; the footer's start delay counts from it.
  useMachineUpdatesStore.setState({ byMachine: {}, startedAt: Date.now(), footer: undefined })
  useMachinesStore.setState({
    machines: [{ id: 'bee', label: 'bee1' } as never, { id: 'stark', label: 'stark' } as never],
  })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local', error: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  stopReadiness = observeReadiness()
})
afterEach(() => {
  stopReadiness()
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function mount(platform: Platform) {
  act(() =>
    root.render(
      <PlatformProvider value={platform}>
        <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
          <UpdatesFooter />
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
}
function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}
const rows = () =>
  [...container.querySelectorAll<HTMLElement>('[data-update-row]:not([aria-hidden="true"])')].map(
    (row) => `${row.dataset.updateRow}: ${row.textContent?.replace(/\s+/g, ' ').trim()}`,
  )
const setApp = (update: UpdateState) => act(() => useUpdatesStore.setState({ update }))
/** Replaces a machine's update facts; its readiness stays the observer's. */
const setEntry = (id: string, entry: MachineUpdateEntry) =>
  act(() =>
    useMachineUpdatesStore.setState((s) => {
      const { readySince, downSince } = s.byMachine[id] ?? {}
      return { byMachine: { ...s.byMachine, [id]: { readySince, downSince, ...entry } } }
    }),
  )
function remount(platform: Platform) {
  act(() => root.unmount())
  root = createRoot(container)
  mount(platform)
}
const button = (slot: string) =>
  container.querySelector<HTMLButtonElement>(`[data-update-row="${slot}"] button`)!

it('shows nothing during app start, then the app row above This Mac’s service row on Desktop', () => {
  useRemoteLanesStore.setState({ hosts: { svc: host({ local: true }) }, filter: 'svc' })
  setEntry('svc', available)
  setApp({ phase: 'downloaded', version: '2.0.0' })
  mount(DESKTOP_PLATFORM)
  expect(rows()).toEqual([])
  wait(2999)
  expect(rows()).toEqual([])
  wait(1)
  expect(rows()).toEqual([
    'app: Desktop · Restart to update',
    'machine: This Mac · Update available',
  ])
})

it('shows the app download percent and the Host in scope on Desktop', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'bee' })
  setEntry('bee', available)
  setApp({ phase: 'downloading', version: '2.0.0', progressPercent: 42 })
  mount(DESKTOP_PLATFORM)
  wait(3000)
  expect(rows()).toEqual(['app: Desktop · Downloading 42%', 'machine: bee1 · Update available'])
})

it('shows only the machine row on the PWA', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'bee' })
  setEntry('bee', available)
  setApp({ phase: 'downloaded', version: '2.0.0' })
  mount(COMPACT_PLATFORM)
  wait(3000)
  expect(rows()).toEqual(['machine: bee1 · Update available'])
})

it('shows no machine row for in-app This Mac', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'local' })
  setEntry('bee', available)
  setApp({ phase: 'manual-download', version: '2.0.0' })
  mount(DESKTOP_PLATFORM)
  wait(3000)
  expect(rows()).toEqual(['app: Desktop · Download update'])
})

it('shows “Update available” only after a read and 3 seconds of ready', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host({ state: 'connecting' }) }, filter: 'bee' })
  mount(COMPACT_PLATFORM)
  wait(3000)
  act(() => useRemoteLanesStore.setState({ hosts: { bee: host() } }))
  wait(5000)
  expect(rows()).toEqual([]) // no read yet: a newer peer alone is not enough to wait on
  setEntry('bee', available)
  wait(0)
  expect(rows()).toEqual(['machine: bee1 · Update available'])
  act(() => useRemoteLanesStore.setState({ hosts: { bee: host({ state: 'reconnecting' }) } }))
  act(() => useRemoteLanesStore.setState({ hosts: { bee: host({ connectionToken: '2' }) } }))
  wait(10)
  expect(rows()).toEqual(['machine: bee1 · Update available'])
})

it('keeps a stale row through a reconnect for up to 10 minutes', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'bee' })
  setEntry('bee', available)
  mount(COMPACT_PLATFORM)
  wait(3000)
  act(() => useRemoteLanesStore.setState({ hosts: { bee: host({ state: 'reconnecting' }) } }))
  wait(10 * 60_000 - 1000)
  expect(rows()).toEqual(['machine: bee1 · Update available'])
  wait(1000)
  wait(150)
  expect(rows()).toEqual([])
})

it('lets a running update outrank the scope until it ends', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host(), stark: host() }, filter: 'stark' })
  setEntry('stark', available)
  setEntry('bee', {
    version: '1.2.0',
    run: run({
      step: 'waiting',
      reached: 'waiting',
      waiting: {
        kind: 'pausing',
        purpose: 'update',
        since: 'now',
        deadline: 'later',
        waitingOn: { turns: 2, subagents: 0, routines: 0 },
      },
    }),
  })
  mount(DESKTOP_PLATFORM)
  wait(3000)
  expect(rows()).toEqual(['machine: bee1 · Waiting for 2 turns'])
  act(() => useRemoteLanesStore.setState({ filter: 'local' }))
  wait(1000)
  expect(rows()).toEqual(['machine: bee1 · Waiting for 2 turns'])
})

it('holds each phase at least 600 ms and shows the result 8 seconds', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'bee' })
  setEntry('bee', { version: '1.2.0', run: run({}) })
  mount(COMPACT_PLATFORM)
  wait(3000)
  expect(rows()).toEqual(['machine: bee1 · Downloading update…'])
  setEntry('bee', { version: '1.2.0', run: run({ step: 'restarting', reached: 'restarting' }) })
  wait(100)
  setEntry('bee', {
    version: '1.3.0',
    run: run({ step: 'health', reached: 'health', finish: 'updated', to: '1.3.0' }),
  })
  wait(100)
  expect(rows()).toEqual(['machine: bee1 · Downloading update…'])
  setEntry('bee', {
    version: '1.3.0',
    run: run({
      step: 'health',
      reached: 'health',
      finish: 'updated',
      to: '1.3.0',
      settled: true,
      settledAt: Date.now(),
    }),
  })
  wait(400)
  expect(rows()).toEqual(['machine: bee1 · Updated to 1.3.0'])
  wait(7000)
  expect(rows()).toEqual(['machine: bee1 · Updated to 1.3.0'])
  wait(1000)
  wait(150)
  expect(rows()).toEqual([])
})

it('keeps a failed update until it is opened, and opens that machine’s Advanced settings', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'bee' })
  const failed = run({ finish: 'download', settled: true, settledAt: 0 })
  setEntry('bee', { version: '1.2.0', run: failed })
  mount(COMPACT_PLATFORM)
  wait(3000)
  wait(60 * 60_000)
  expect(rows()).toEqual(['machine: bee1 · Update didn’t finish'])
  act(() =>
    container.querySelector<HTMLButtonElement>('[data-update-row="machine"] button')!.click(),
  )
  expect(useSettingsUiStore.getState().tab).toBe('advanced')
  expect(navigate).toHaveBeenCalledWith({ to: 'page', page: 'settings', machine: 'bee' })
  setEntry('bee', { version: '1.2.0', run: { ...failed, seen: true } })
  wait(150)
  expect(rows()).toEqual([])
})

it('cross-fades a scope switch in place and waits 150 ms before collapsing', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host(), stark: host() }, filter: 'bee' })
  setEntry('bee', available)
  setEntry('stark', {
    ...available,
    status: { pause: { kind: 'none' }, update: { supported: true, available: '1.4.0' } },
  })
  mount(COMPACT_PLATFORM)
  wait(3000)
  act(() => useRemoteLanesStore.setState({ filter: 'stark' }))
  expect(rows()).toEqual(['machine: stark · Update available'])
  act(() => useRemoteLanesStore.setState({ filter: 'local' }))
  wait(100)
  expect(rows()).toEqual(['machine: stark · Update available'])
  act(() => useRemoteLanesStore.setState({ filter: 'bee' }))
  wait(100)
  expect(rows()).toEqual(['machine: bee1 · Update available'])
  act(() => useRemoteLanesStore.setState({ filter: 'local' }))
  wait(150)
  // bee1 replaced stark 100 ms ago: it still has its 600 ms.
  expect(rows()).toEqual(['machine: bee1 · Update available'])
  wait(350)
  expect(rows()).toEqual([])
})

it('waits out a phase’s 600 ms before collapsing it', () => {
  mount(DESKTOP_PLATFORM)
  wait(3000)
  setApp({ phase: 'downloading', version: '2.0.0', progressPercent: 1 })
  wait(100)
  setApp({ phase: 'idle' })
  wait(150)
  expect(rows()).toEqual(['app: Desktop · Downloading 1%'])
  wait(349)
  expect(rows()).toEqual(['app: Desktop · Downloading 1%'])
  wait(1)
  expect(rows()).toEqual([])
})

it('applies the start delay once per app, not each time the sidebar mounts', () => {
  setApp({ phase: 'downloaded', version: '2.0.0' })
  mount(DESKTOP_PLATFORM)
  wait(3000)
  act(() => root.unmount())
  root = createRoot(container)
  mount(DESKTOP_PLATFORM)
  expect(rows()).toEqual(['app: Desktop · Restart to update'])
})

it('lets an active run on one machine outrank an unread result on another', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host(), stark: host() }, filter: 'local' })
  setEntry('bee', {
    version: '1.2.0',
    run: run({ started: 1, finish: 'download', settled: true, settledAt: 0 }),
  })
  setEntry('stark', { version: '1.2.0', run: run({ started: 2 }) })
  mount(COMPACT_PLATFORM)
  wait(3000)
  expect(rows()).toEqual(['machine: stark · Downloading update…'])
})

it('keeps an offer through a reconnect until a status read on the new connection says current', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'bee' })
  setEntry('bee', { ...available, readToken: '1' })
  mount(COMPACT_PLATFORM)
  wait(3000)
  act(() =>
    useRemoteLanesStore.setState({
      hosts: { bee: host({ connectionToken: '2', hostVersion: '1.3.0' }) },
    }),
  )
  wait(5000)
  expect(rows()).toEqual(['machine: bee1 · Update available'])
  setEntry('bee', {
    version: '1.3.0',
    readToken: '2',
    status: { pause: { kind: 'none' }, update: { supported: true } },
  })
  wait(1000)
  expect(rows()).toEqual([])
})

it('shows a rollback the Host reported without a tracked run', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'bee' })
  const last = {
    from: '1.2.0',
    to: '1.3.0',
    outcome: 'rolled-back' as const,
    at: new Date(Date.now() - 60_000).toISOString(),
  }
  setEntry('bee', {
    version: '1.2.0',
    last,
    run: reportedRun({}, last, Date.now()),
  })
  mount(COMPACT_PLATFORM)
  wait(3000)
  expect(rows()).toEqual(['machine: bee1 · Update didn’t finish'])
})

it('keeps a machine’s readiness across mounts: a reopened sidebar shows its offer at once', () => {
  useMachineUpdatesStore.setState({ startedAt: Date.now() - 60_000 })
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'bee' })
  wait(10_000)
  setEntry('bee', available)
  mount(DESKTOP_PLATFORM)
  expect(rows()).toEqual(['machine: bee1 · Update available'])
})

it('keeps a row’s dwell and collapse across a remount', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'bee' })
  setEntry('bee', available)
  mount(COMPACT_PLATFORM)
  wait(3000)
  expect(rows()).toEqual(['machine: bee1 · Update available'])
  act(() => root.unmount())
  act(() => useRemoteLanesStore.setState({ filter: 'local' }))
  root = createRoot(container)
  mount(COMPACT_PLATFORM)
  expect(rows()).toEqual(['machine: bee1 · Update available'])
  wait(150)
  expect(rows()).toEqual([])
})

it('keeps the old text during its dwell but never its old action', () => {
  setApp({ phase: 'downloaded', version: '2.0.0' })
  mount(DESKTOP_PLATFORM)
  wait(3000)
  setApp({ phase: 'installing', version: '2.0.0' })
  expect(rows()).toEqual(['app: Desktop · Restart to update'])
  expect(button('app').disabled).toBe(true)
  act(() => button('app').click())
  expect(window.phosphor.invoke).not.toHaveBeenCalledWith('updates:restartAndInstall')
  wait(600)
  expect(rows()).toEqual(['app: Desktop · Installing…'])
})

it('opens nothing from a machine row that is collapsing', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host() }, filter: 'bee' })
  setEntry('bee', available)
  mount(COMPACT_PLATFORM)
  wait(3000)
  act(() => useRemoteLanesStore.setState({ filter: 'local' }))
  expect(rows()).toEqual(['machine: bee1 · Update available'])
  act(() => button('machine').click())
  expect(navigate).not.toHaveBeenCalled()
})

it('shows the 8 second result before a newer offer', () => {
  useRemoteLanesStore.setState({ hosts: { bee: host({ hostVersion: '1.3.0' }) }, filter: 'bee' })
  setEntry('bee', {
    version: '1.3.0',
    status: { pause: { kind: 'none' }, update: { supported: true, available: '1.4.0' } },
    run: run({
      step: 'health',
      reached: 'health',
      finish: 'updated',
      to: '1.3.0',
      settled: true,
      settledAt: Date.now() + 2000,
    }),
  })
  mount(COMPACT_PLATFORM)
  wait(3000)
  expect(rows()).toEqual(['machine: bee1 · Updated to 1.3.0'])
  wait(7000)
  expect(rows()).toEqual(['machine: bee1 · Update available'])
})
