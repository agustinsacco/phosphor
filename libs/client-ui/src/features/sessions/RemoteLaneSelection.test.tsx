// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteLanes } from './RemoteLanes'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { clearLaneSelection } from './laneSelection'

vi.mock('@/lib/monaco', () => ({}))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn().mockResolvedValue(null)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'phosphor', { configurable: true, value: { invoke } })
  useMachinesStore.setState({ remoteEnabled: true, machines: [], adding: false })
  const host = structuredClone(mockRemoteHosts)[MOCK_HOST_ID]!
  host.capabilities.push('workspaces.write')
  const first = host.lanes[0]!
  const lane = (n: number, self: boolean) => ({
    ...first,
    laneId: `00000000-0000-4000-8000-00000000009${n}`,
    title: `Lane ${n}`,
    branch: `branch-${n}`,
    control: {
      ...first.control,
      controller: { self, label: self ? 'You' : 'iPad', connected: true },
    },
  })
  host.lanes = [lane(1, true), lane(2, false), lane(3, true), lane(4, true)]
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host }, filter: 'all', error: null })
  useSessionsStore.setState({ live: {}, bulkDelete: null })
  usePullRequestsStore.setState({ byRepo: {} })
  clearLaneSelection()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const boxes = (within: ParentNode = container) => [
  ...within.querySelectorAll<HTMLElement>('[role=checkbox]'),
]
const box = (title: string, within: ParentNode = container) =>
  boxes(within).find((b) => b.getAttribute('aria-label') === `Select ${title}`)!
const checked = (within: ParentNode = container) =>
  boxes(within)
    .filter((b) => b.getAttribute('aria-checked') === 'true')
    .map((b) => b.getAttribute('aria-label'))
const click = (el: Element, shiftKey = false): void =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }))
  })
const button = (text: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
const bar = () => container.querySelector('[data-testid=bulk-bar]')

it('gives Host rows This Mac’s hover box, disabled where another device holds the lane', async () => {
  await act(async () => root.render(<RemoteLanes />))
  expect(boxes().map((b) => b.getAttribute('aria-label'))).toEqual([
    'Select Lane 1',
    'Select Lane 2',
    'Select Lane 3',
    'Select Lane 4',
  ])
  expect(boxes().every((b) => b.className.includes('hidden group-hover:grid'))).toBe(true)
  expect(box('Lane 2').getAttribute('aria-disabled')).toBe('true')
  expect(box('Lane 2').dataset.tooltip).toBe('Take control first.')
  click(box('Lane 2'))
  expect(checked()).toEqual([])
  expect(bar()).toBeNull()
})

it('extends a shift range over the lanes this client may delete, then clears on Escape', async () => {
  await act(async () => root.render(<RemoteLanes />))
  click(box('Lane 1'))
  click(box('Lane 4'), true)
  expect(checked()).toEqual(['Select Lane 1', 'Select Lane 3', 'Select Lane 4'])
  expect(bar()?.textContent).toContain('3 selected')
  click(container.querySelector('[aria-label^="Workspace options"]')!)
  expect(button('Clear selection')).toBeDefined()
  click(button('Clear selection'))
  click(box('Lane 3'))
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(checked()).toEqual([])
  expect(bar()).toBeNull()
})

it('holds select mode with Delete off when Select merged finds nothing merged', async () => {
  await act(async () => root.render(<RemoteLanes />))
  click(container.querySelector('[aria-label^="Workspace options"]')!)
  click(button('Select merged lanes'))
  expect(bar()?.textContent).toContain('0 selected')
  expect(button('Delete…').disabled).toBe(true)
  expect(boxes().some((b) => b.className.includes('hidden'))).toBe(false)
  click(button('Cancel'))
  expect(bar()).toBeNull()
})

it('keeps a selection to the list that made it when a folder shows in two', async () => {
  await act(async () =>
    root.render(
      <>
        <div data-testid="one">
          <RemoteLanes />
        </div>
        <div data-testid="two">
          <RemoteLanes />
        </div>
      </>,
    ),
  )
  const one = container.querySelector('[data-testid=one]')!
  const two = container.querySelector('[data-testid=two]')!
  click(box('Lane 1', one))
  expect(checked(one)).toEqual(['Select Lane 1'])
  expect(checked(two)).toEqual([])
  click(box('Lane 3', two))
  expect(checked(one)).toEqual([])
  expect(checked(two)).toEqual(['Select Lane 3'])
})
