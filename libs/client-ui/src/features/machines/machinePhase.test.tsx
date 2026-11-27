// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostLaneSession, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import type { Location } from '@/navigation/location'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { CompactLaneHeader } from '@/shell/compact/CompactLaneHeader'
import { MACHINE_START_LIMIT_MS } from '@/stores/hostReadiness'
import { useMachinesStore } from '@/stores/machines'
import { machineLabel, REMOTE_NOT_READY, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { HostWaitNote } from './HostWaitNote'
import { HostMachineChip } from './RemoteLaneControls'

/*
 * The lane header (Desktop's chip, the wide browser's chip, the phone's lane bar) and
 * the composer's note say the same thing about a machine, because they read one helper.
 * This Mac's boot window ends at the client's lane.resume deadline: after it, the
 * machine reads as not connected, with a Retry, never "Starting" forever.
 */
const SESSION = mockRemoteInfo.sessionId
const location: Extract<Location, { to: 'lane' }> = {
  to: 'lane',
  lane: { hostId: MOCK_HOST_ID, laneId: mockRemoteInfo.laneId! },
  pane: 'chat',
}
const invoke = vi.fn().mockResolvedValue(undefined)
let root: Root
let el: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  useMachinesStore.setState({ machines: [] })
  invoke.mockClear()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  act(() => useRemoteLanesStore.setState({ hosts: {} }))
  useSessionsStore.setState({ live: {} })
  vi.useRealTimers()
})

function grantNothing(local: boolean): void {
  const { hosts, live } = hostLaneSession({ self: true })
  const host = hosts[MOCK_HOST_ID]!
  if (local) host.local = true
  host.capabilities = []
  useSessionsStore.setState({ live })
  act(() => useRemoteLanesStore.setState({ hosts }))
}

function render(): { chip: string; bar: string; note: string } {
  act(() =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <NavigationProvider value={{ location, navigate: vi.fn() }}>
          <HostMachineChip hostId={MOCK_HOST_ID} />
          <CompactLaneHeader location={location} />
          <HostWaitNote sessionId={SESSION} />
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
  return {
    chip: el.querySelector('[data-testid="machine-chip"]')?.textContent ?? '',
    bar: el.querySelector('.compact-lane-status')?.textContent ?? '',
    note: [...el.querySelectorAll('[role="status"]')].map((n) => n.textContent).join(' '),
  }
}

const label = (): string => machineLabel(MOCK_HOST_ID)

describe('one machine status for the header and the composer', () => {
  it('an enrolled Host that grants nothing reads as not connected in both', () => {
    grantNothing(false)
    const { chip, bar, note } = render()
    expect(note).toContain(REMOTE_NOT_READY)
    expect(chip).toBe(`${label()} · Down`)
    expect(bar).toContain('Down')
    expect(bar).not.toContain('Connected')
  })

  it("This Mac's booting service reads as starting in both", () => {
    grantNothing(true)
    const { chip, bar, note } = render()
    expect(note).toContain(`Starting ${label()}…`)
    expect(chip).toBe(`${label()} · Starting`)
    expect(bar).toContain('Starting')
    expect(bar).not.toContain('Connected')
  })
})

describe("This Mac's boot window", () => {
  it('ends at the lane.resume deadline as not connected with a Retry', () => {
    vi.useFakeTimers()
    grantNothing(true)
    render()
    act(() => vi.advanceTimersByTime(MACHINE_START_LIMIT_MS - 1))
    expect(render().note).toContain(`Starting ${label()}…`)
    act(() => vi.advanceTimersByTime(1))
    const { chip, bar, note } = render()
    expect(note).toContain(REMOTE_NOT_READY)
    expect(note).not.toContain('Starting')
    expect(chip).toBe(`${label()} · Down`)
    expect(bar).not.toContain('Starting')
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry')
    expect(retry).toBeDefined()
    act(() => retry!.click())
    expect(invoke).toHaveBeenCalledWith('hosts:reconnect', MOCK_HOST_ID)
    // A retry gives the service a fresh window.
    expect(render().note).toContain(`Starting ${label()}…`)
  })

  it('restarts when the service reconnects and boots again', () => {
    vi.useFakeTimers()
    grantNothing(true)
    render()
    act(() => vi.advanceTimersByTime(MACHINE_START_LIMIT_MS))
    act(() =>
      useRemoteLanesStore.setState((s) => ({
        hosts: { ...s.hosts, [MOCK_HOST_ID]: { ...s.hosts[MOCK_HOST_ID]!, state: 'reconnecting' } },
      })),
    )
    grantNothing(true)
    expect(render().note).toContain(`Starting ${label()}…`)
  })
})
