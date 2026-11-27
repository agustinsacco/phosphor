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
import type { MachineUpdateEntry, UpdateRun } from './machineUpdateState'
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
const navigate = vi.fn()

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
  useMachineUpdatesStore.setState({ byMachine: {} })
  useMachinesStore.setState({
    machines: [{ id: 'bee', label: 'bee1' } as never, { id: 'stark', label: 'stark' } as never],
  })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local', error: null })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
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
const setEntry = (id: string, entry: MachineUpdateEntry) =>
  act(() =>
    useMachineUpdatesStore.setState((s) => ({ byMachine: { ...s.byMachine, [id]: entry } })),
  )

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
  expect(rows()).toEqual([])
})
