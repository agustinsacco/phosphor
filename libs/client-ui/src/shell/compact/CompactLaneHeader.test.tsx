// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import type { Location } from '@/navigation/location'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { useChatStore } from '@/stores/chat'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { CompactLaneHeader } from './CompactLaneHeader'

const LANE = mockRemoteInfo.laneId!
const location: Extract<Location, { to: 'lane' }> = {
  to: 'lane',
  lane: { hostId: MOCK_HOST_ID, laneId: LANE },
  pane: 'chat',
}
let root: Root
let container: HTMLDivElement
const invoke = vi.fn().mockResolvedValue(undefined)
const navigate = vi.fn()

function controller(self: boolean): void {
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.lanes[0]!.control.controller = self
    ? { label: 'This phone', connected: true, self: true }
    : { label: 'Another Desktop', connected: true, self: false }
  act(() => useRemoteLanesStore.setState({ hosts }))
}
function render(at = location): void {
  act(() =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <NavigationProvider value={{ location: at, navigate }}>
          <CompactLaneHeader location={at} />
        </NavigationProvider>
      </PlatformProvider>,
    ),
  )
}
const button = (name: string | RegExp): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find((b) =>
    typeof name === 'string'
      ? (b.getAttribute('aria-label') ?? b.textContent) === name
      : name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  )
const sheet = (): HTMLElement | null => document.querySelector('[role="dialog"]')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  useMachinesStore.setState({ machines: [] })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts) })
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: {
        phosphorId: mockRemoteInfo.sessionId,
        workspacePath: mockRemoteInfo.workspacePath,
        target: mockRemoteInfo.target,
        laneId: LANE,
      },
    },
  })
  useChatStore.setState({ sessions: {} } as unknown as Partial<
    ReturnType<typeof useChatStore.getState>
  >)
  invoke.mockClear()
  navigate.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('is one bar: Back and the lane title with its Host and controller', () => {
  render()
  const header = container.querySelector('header')!
  expect([...header.querySelectorAll(':scope > button')]).toHaveLength(2)
  expect(header.querySelector('select')).toBeNull()
  expect(header.textContent).toContain('Remote demo lane')
  expect(header.textContent).toContain(`${MOCK_HOST_ID}·Controlled by Another Desktop`)
  act(() => button('Back to lanes')!.click())
  expect(navigate).toHaveBeenCalledWith({ to: 'lanes', machine: MOCK_HOST_ID })
})

it('names a pane other than Chat and switches panes from the lane menu', () => {
  render({ ...location, pane: 'files' })
  expect(button(/^Lane menu/)!.textContent).toContain('Files')
  act(() => button(/^Lane menu/)!.click())
  const panes = sheet()!.querySelector('nav[aria-label="Lane panes"]')!
  expect(panes.querySelector('[aria-current="page"]')!.textContent).toBe('Files')
  act(() => button('Changes')!.click())
  expect(navigate).toHaveBeenCalledWith({ ...location, pane: 'changes' })
  expect(sheet()).toBeNull()
})

it('offers Take control to a reader and closes once the Host confirms', async () => {
  render()
  act(() => button(/^Lane menu/)!.click())
  expect(button('Release control')).toBeUndefined()
  await act(async () => button('Take control')!.click())
  expect(invoke).toHaveBeenCalledWith('hosts:takeControl', MOCK_HOST_ID, LANE)
  expect(sheet()).toBeNull()
})

it('keeps the menu open with the reason when the Host refuses', async () => {
  invoke.mockRejectedValueOnce(new Error('refused'))
  render()
  act(() => button(/^Lane menu/)!.click())
  await act(async () => button('Take control')!.click())
  expect(sheet()!.querySelector('[role="alert"]')!.textContent).toContain('could not confirm')
})

it('gives the controller Release and Stop, with Stop explained until a first message', () => {
  controller(true)
  render()
  act(() => button(/^Lane menu/)!.click())
  expect(button('Take control')).toBeUndefined()
  expect(button('Release control')!.disabled).toBe(false)
  const stop = button(/^Stop lane/)!
  expect(stop.disabled).toBe(true)
  expect(stop.textContent).toContain('Send a first message')
  act(() => button(/^New lane on/)!.click())
  expect(navigate).toHaveBeenCalledWith({ to: 'new', machine: MOCK_HOST_ID })
})

it('lists the shared lane actions in the sheet, with the same hints as every lane menu (regression)', () => {
  render()
  act(() => button(/^Lane menu/)!.click())
  const group = sheet()!.querySelector('[aria-label="Lane actions"]')!
  const rows = [...group.querySelectorAll('button')]
  expect(
    rows.map((b) => b.querySelector('span:not(.action-sheet-icon) > span')?.textContent),
  ).toEqual([
    'Rename',
    'Take control',
    'Stop',
    'Mark read',
    'Pin',
    'Lane marker',
    'Copy debug info',
    'Copy spend',
    'Delete',
    `New lane on ${MOCK_HOST_ID}`,
  ])
  const row = (label: string) => rows.find((b) => b.textContent?.startsWith(label))!
  expect(row('Delete').disabled).toBe(true)
  expect(row('Delete').textContent).toContain('Take control first.')
  expect(row('Pin').disabled).toBe(true)
  expect(row('Pin').textContent).toContain('Update this Host')
})

it('lets the controller delete the lane from the sheet (regression)', () => {
  controller(true)
  act(() =>
    useRemoteLanesStore.setState((s) => ({
      hosts: {
        [MOCK_HOST_ID]: {
          ...s.hosts[MOCK_HOST_ID]!,
          capabilities: ['sessions.read', 'sessions.control', 'workspaces.write'],
        },
      },
    })),
  )
  render()
  act(() => button(/^Lane menu/)!.click())
  const remove = button(/^Delete/)
  expect(remove?.disabled).toBe(false)
  if (!remove) return
  act(() => remove.click())
  expect(sheet()?.getAttribute('aria-label')).not.toBe('Lane menu')
  expect(document.body.textContent).toContain('Delete session')
})
