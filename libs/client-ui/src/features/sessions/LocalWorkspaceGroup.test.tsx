// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { useSessionsStore } from '@/stores/sessions'
import { resetSidebarStores, stubSidebarPhosphor } from './__fixtures__/sidebarHarness'
import { Sidebar } from './Sidebar'

vi.mock('@/lib/monaco', () => ({}))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  stubSidebarPhosphor(invoke)
  invoke
    .mockReset()
    .mockImplementation(async (channel: string) =>
      channel === 'app:getPrefs' || channel === 'routines:laneIndex'
        ? {}
        : channel === 'git:listWorktrees' || channel === 'sessions:list'
          ? []
          : null,
    )
  resetSidebarStores()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const lane = (n: number): SessionMeta =>
  ({
    path: `/repo/s${n}.jsonl`,
    sessionId: `s${n}`,
    cwd: '/repo',
    createdAt: '',
    name: `Lane ${n}`,
    firstUserText: '',
    mtimeMs: 10 - n,
    lastActivityAt: '',
    branchCount: 0,
    cost: 0,
  }) as SessionMeta

it("counts a whitespace-only search's matches over the scanned lanes, not the pending rows", async () => {
  useSessionsStore.setState({
    live: { live9: { phosphorId: 'live9', workspacePath: '/repo' } },
    disk: { '/repo': [lane(1), lane(2), lane(3)] },
    scanStatus: { '/repo': 'ok' },
    refreshAllDisk: vi.fn().mockResolvedValue(undefined),
    refreshMissing: vi.fn().mockResolvedValue(undefined),
    hydratePinned: vi.fn().mockResolvedValue(undefined),
    refreshDisk: vi.fn().mockResolvedValue(undefined),
  })
  await act(async () => root.render(<Sidebar workspacePath="/repo" />))
  await act(async () => {})
  act(() => container.querySelector<HTMLElement>('[aria-label^="Search lanes in"]')!.click())
  const input = container.querySelector<HTMLInputElement>('[data-testid=lane-search-input]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '  ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(input.parentElement!.textContent).toContain('3/3')
})
