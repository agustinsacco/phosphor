// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostsSnapshot } from '@shared/ipc'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { MACHINE } from './__fixtures__/control'
import { HealthBadge } from './HealthBadge'
import { useMachineHealthStore } from './healthStore'

const originalRefresh = useMachinesStore.getState().refresh
const machine = {
  ...MACHINE,
  lastSeenAt: new Date().toISOString(),
  state: 'running' as const,
  endpoint: 'https://bee1.tail.ts.net:47615',
}
const hosts: HostsSnapshot = {
  [MACHINE.id]: {
    connectionToken: 't',
    state: 'ready',
    capabilities: [],
    lanes: [],
    repositories: [],
  } as unknown as HostsSnapshot[string],
}
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'control:machines')
    return { ok: true, machines: [machine], serverTime: new Date().toISOString() }
  if (channel === 'hosts:tailscaleStatus') return { code: 'ready' }
  if (channel === 'pi:health') return { ok: true, version: '1.2.0' }
  if (channel === 'hosts:snapshot') return hosts
  return undefined
})
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, platform: 'linux' })
  invoke.mockClear()
  useMachinesStore.setState({
    refresh: originalRefresh,
    remoteEnabled: true,
    machines: [machine],
    nowMs: Date.now(),
    clockOffsetMs: 0,
    error: null,
  })
  useRemoteLanesStore.setState({ hosts })
  useMachineHealthStore.setState({ run: null, running: false })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useRemoteLanesStore.setState({ hosts: {} })
  useMachinesStore.getState().enableRemote(false)
  vi.unstubAllGlobals()
})
const button = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === text || b.getAttribute('aria-label') === text,
  )
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
const badge = (): HTMLElement => document.querySelector('[data-testid=health-badge]')!

it('opens the check, runs every read, reconnects one Host and opens the log', async () => {
  const onOpenLog = vi.fn()
  await act(async () => root.render(<HealthBadge signedIn onOpenLog={onOpenLog} />))
  expect(badge().textContent).toContain('All systems normal')
  expect(badge().dataset.tone).toBe('ok')
  await act(async () => badge().click())
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('No check has run')
  await act(async () => button('Run check').click())
  const steps = [...document.querySelectorAll('[data-step]')].map((s) =>
    s.getAttribute('data-step'),
  )
  expect(steps).toEqual(expect.arrayContaining(['control', 'tailscale', 'pi', 'connection']))
  expect(invoke).toHaveBeenCalledWith('control:machines')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('Run again')
  // A ready Host without grants is not a failure: its reads say why they did not run.
  expect(document.querySelector('[data-step=providers]')?.textContent).toContain('Not granted')
  expect(badge().textContent).toContain('All systems normal')
  await act(async () => button('Reconnect').click())
  expect(invoke).toHaveBeenCalledWith('hosts:reconnect', MACHINE.id)
  await act(async () => button('Open debug log').click())
  expect(onOpenLog).toHaveBeenCalledOnce()
  expect(document.querySelector('[role=dialog]')).toBeNull()
})

it('counts a failing read as an issue, and the refresh button runs the check', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'control:machines')
      return { ok: true, machines: [machine], serverTime: new Date().toISOString() }
    if (channel === 'hosts:tailscaleStatus') return { code: 'not-installed' }
    if (channel === 'pi:health') return { ok: true, version: '1.2.0' }
    if (channel === 'hosts:snapshot') return hosts
    return undefined
  })
  await act(async () => root.render(<HealthBadge signedIn onOpenLog={() => {}} />))
  await act(async () => button('Refresh').click())
  expect(badge().textContent).toContain('1 issue')
  expect(badge().dataset.tone).toBe('warn')
})
