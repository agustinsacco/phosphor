// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { MACHINE } from '@/features/machines/__fixtures__/control'
import { NavigationProvider } from '@/navigation/Navigation'
import { useChatStore } from '@/stores/chat'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { HomeBoard } from './HomeBoard'

const navigate = vi.fn()
let root: Root
let el: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => undefined) })
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]!
  host.lanes = [
    { ...host.lanes[0]!, laneId: 'asking', title: 'Asking lane', activity: 'needs-input' },
    { ...host.lanes[0]!, laneId: 'idle', title: 'Idle lane', activity: 'idle' },
  ]
  useMachinesStore.setState({
    loading: false,
    machines: [{ ...MACHINE, id: MOCK_HOST_ID, label: 'bee2' }],
  })
  useRemoteLanesStore.setState({ hosts, snapshotStatus: 'ready' })
  useSessionsStore.setState({
    live: { local: { phosphorId: 'local', workspacePath: '/w/phosphor' } },
    disk: {},
    gitByCwd: {},
  })
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure('local')
  useChatStore.setState((s) => ({
    sessions: { ...s.sessions, local: { ...s.sessions.local!, isStreaming: true } },
  }))
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

const section = (name: string): string[] =>
  [...el.querySelectorAll(`section[aria-label="${name}"] button[aria-label]`)].map(
    (b) => b.getAttribute('aria-label') ?? '',
  )

it('puts every machine’s lanes in one board: what needs you, what runs, then the rest', () => {
  act(() =>
    root.render(
      <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
        <HomeBoard />
      </NavigationProvider>,
    ),
  )
  expect(section('Needs you')).toEqual(['Asking lane'])
  // This computer's streaming lane is drawn by its own row, beside the Host's.
  expect(section('Working')).toEqual(['New session'])
  expect(section('Recent')).toEqual(['Idle lane'])
  const badges = [...el.querySelectorAll('[data-testid=session-workspace-badge]')].map(
    (b) => b.textContent,
  )
  expect(badges).toContain('bee2 · Demo repository')
  expect(badges.some((b) => b?.endsWith('· phosphor'))).toBe(true)
})

it('says how to start when no machine has a lane', () => {
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {}, disk: {} })
  act(() =>
    root.render(
      <NavigationProvider value={{ location: { to: 'lanes' }, navigate }}>
        <HomeBoard />
      </NavigationProvider>,
    ),
  )
  expect(el.querySelector('[data-testid=home-board]')).toBeNull()
  expect(el.textContent).toContain('No lanes yet')
})
