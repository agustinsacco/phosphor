// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { HostHome } from './HostHome'

let root: Root, el: HTMLDivElement
const navigate = vi.fn()

function lane(laneId: string, title: string, over: Partial<HostLaneView> = {}): HostLaneView {
  const base = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!)
  return { ...base, laneId, title, attention: 0, read: 0, ...over }
}
const LANES = [
  lane('old', 'Old lane', { activity: 'stopped' }),
  lane('builds', 'Builds things', { activity: 'working' }),
  lane('asks', 'Asks a question', { activity: 'needs-input' }),
]

function host(edit: (view: HostConnectionView) => void = () => {}): void {
  const view = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  view.lanes = structuredClone(LANES)
  view.capabilities.push('workspaces.write')
  edit(view)
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: view },
    filter: MOCK_HOST_ID,
    snapshotStatus: 'ready',
  })
}
function render(): void {
  act(() =>
    root.render(
      <NavigationProvider value={{ location: { to: 'new', machine: MOCK_HOST_ID }, navigate }}>
        <HostHome hostId={MOCK_HOST_ID} />
      </NavigationProvider>,
    ),
  )
}
const dots = () => [...el.querySelectorAll<HTMLButtonElement>('.host-orbit-dot')]
const dot = (title: string) => dots().find((d) => d.getAttribute('aria-label')!.startsWith(title))!
const core = () => el.querySelector('.host-orbit-core')!.textContent
function pointer(type: string, target: Element, pointerType: string, related?: Element): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: related })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  act(() => {
    target.dispatchEvent(event)
  })
}
function tap(target: Element, pointerType = 'touch'): void {
  pointer('pointerdown', target, pointerType)
  act(() => (target as HTMLElement).click())
}
const opened = (laneId: string) => ({ to: 'lane', lane: { hostId: MOCK_HOST_ID, laneId } })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke: vi.fn() } })
  navigate.mockReset()
  useMachinesStore.setState({
    remoteEnabled: true,
    loading: false,
    error: null,
    machines: [
      {
        id: MOCK_HOST_ID,
        label: 'Test Host',
        hostname: 'test',
        platform: 'linux',
        arch: 'arm64',
        hostVersion: null,
        keyFingerprint: 'test',
        enrolledAt: '2026-09-10T00:00:00.000Z',
        lastSeenAt: null,
        state: null,
        readiness: null,
        lanes: null,
        endpoint: null,
      },
    ],
  })
  useSessionsStore.setState({ live: {} })
  host()
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

it('puts one dot per lane on the ring, most pressing first, and counts what needs you', () => {
  render()
  expect(el.querySelector('[role=group]')?.getAttribute('aria-label')).toBe('Lanes on Test Host')
  expect(dots().map((d) => d.getAttribute('aria-label')!.split(',')[0])).toEqual([
    'Asks a question',
    'Builds things',
    'Old lane',
  ])
  expect(dots().map((d) => d.dataset.tone)).toEqual(['needs-you', 'working', 'idle'])
  expect(core()).toBe('1needs you1 working · 3 lanes')
  // The orbit turns only while something works.
  expect(el.querySelector('.host-orbit-sweep')).not.toBeNull()
  expect(el.querySelector('h2')?.textContent).toBe('Test Host')
})

it('previews a lane under the mouse and opens it on click', () => {
  render()
  pointer('pointerover', dot('Builds'), 'mouse')
  expect(core()).toContain('Builds things')
  expect(core()).toContain('Working')
  pointer('pointerout', dot('Builds'), 'mouse', document.body)
  expect(core()).toContain('1needs you')
  tap(dot('Builds'), 'mouse')
  expect(navigate).toHaveBeenCalledWith(opened('builds'))
})

it('is one tab stop that arrows walk, and Enter opens the focused lane', () => {
  render()
  expect(dots().map((d) => d.tabIndex)).toEqual([0, -1, -1])
  act(() => dots()[0]!.focus())
  expect(core()).toContain('Asks a question')
  act(() => {
    dots()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  })
  expect(document.activeElement).toBe(dot('Old lane'))
  expect(dots().map((d) => d.tabIndex)).toEqual([-1, -1, 0])
  expect(core()).toContain('Old lane')
  // A keyboard press is a click with no pointer before it.
  act(() => dot('Old lane').click())
  expect(navigate).toHaveBeenCalledWith(opened('old'))
})

it('previews on a first tap, opens on a second tap or Open, and Escape lets go', () => {
  render()
  tap(dot('Old lane'))
  expect(navigate).not.toHaveBeenCalled()
  expect(core()).toContain('Old lane')
  const open = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Open')!
  act(() => open.click())
  expect(navigate).toHaveBeenCalledWith(opened('old'))
  navigate.mockReset()
  tap(dot('Asks'))
  expect(navigate).not.toHaveBeenCalled()
  tap(dot('Asks'))
  expect(navigate).toHaveBeenCalledWith(opened('asks'))
  tap(dot('Builds'))
  act(() => {
    dot('Builds').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Open')).toBe(false)
})

const key = (target: Element, name: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })

it('steps from where the focused lane sits now after the ring re-sorts', () => {
  render()
  act(() => dot('Old lane').focus())
  // Old lane starts asking: it moves to twelve o'clock, ahead of the other two.
  act(() =>
    host((view) => {
      view.lanes[0] = { ...view.lanes[0]!, activity: 'needs-input' }
    }),
  )
  expect(dots()[0]).toBe(dot('Old lane'))
  expect(document.activeElement).toBe(dot('Old lane'))
  expect(dot('Old lane').tabIndex).toBe(0)
  key(dot('Old lane'), 'ArrowRight')
  expect(document.activeElement).toBe(dots()[1])
})

it('lets the keyboard name its lane over a resting mouse', () => {
  render()
  pointer('pointerover', dot('Old lane'), 'mouse')
  act(() => dots()[0]!.focus())
  key(dots()[0]!, 'ArrowRight')
  expect(core()).toContain('Builds things')
})

it('opens on Enter after a touch that scrolled away', () => {
  render()
  act(() => dot('Builds').focus())
  pointer('pointerdown', dot('Builds'), 'touch')
  pointer('pointercancel', dot('Builds'), 'touch')
  act(() => dot('Builds').click())
  expect(navigate).toHaveBeenCalledWith(opened('builds'))
})

it('rests quietly when nothing is happening', () => {
  host((view) => {
    view.lanes = [lane('old', 'Old lane', { activity: 'stopped' })]
  })
  render()
  expect(el.querySelector('.host-orbit-sweep')).toBeNull()
  expect(core()).toBe('All quiet1 lane')
})

it('offers Add folder on a ready Host with no folders, as the lane lists do', () => {
  host((view) => {
    view.repositories = []
    view.lanes = []
  })
  render()
  expect(dots()).toHaveLength(0)
  expect(core()).toContain('No folders yet')
  expect(
    [...el.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Add folder on')),
  ).toBe(true)
})

it('waits for the lanes while the Host reconnects, and says so under the ring', () => {
  host((view) => {
    view.state = 'reconnecting'
  })
  render()
  expect(dots()).toHaveLength(0)
  expect(core()).toContain('Loading lanes…')
  expect(el.querySelector('.host-home-machine')?.textContent).toBe('Test Host· Reconnecting')
})
