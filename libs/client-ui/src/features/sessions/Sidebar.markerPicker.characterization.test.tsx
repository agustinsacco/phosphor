// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_LANE_PREFS, type SessionMeta } from '@shared/models'
import { ContextMenuHost } from '@/components/ContextMenu'
import { useChatStore } from '@/stores/chat'
import { useLaneMoveStore } from '@/stores/laneMove'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { resetSidebarStores, stubSidebarPhosphor } from './__fixtures__/sidebarHarness'
import { Sidebar } from './Sidebar'

/* This Mac's lane marker picker: what it dims and what Auto and None write. */

vi.mock('@/lib/monaco', () => ({}))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

const meta = (n: number, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  path: `/repo/s${n}.jsonl`,
  sessionId: `s${n}`,
  cwd: '/repo',
  createdAt: '',
  name: `Lane ${n}`,
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  headroomSavedTokens: 0,
  entryCount: 2,
  branchCount: 0,
  mtimeMs: 10 - n,
  lastActivityAt: '',
  ...patch,
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  stubSidebarPhosphor(invoke)
  invoke.mockReset().mockImplementation(async (channel: string) =>
    channel === 'app:getPrefs'
      ? {
          seenSessions: useSessionsStore.getState().seenSessions,
          pinnedSessions: useSessionsStore.getState().pinned,
          laneMarkers: useSessionsStore.getState().laneMarkers,
        }
      : channel === 'routines:laneIndex'
        ? {}
        : channel === 'git:listWorktrees'
          ? []
          : channel === 'sessions:list'
            ? (useSessionsStore.getState().disk['/repo'] ?? [])
            : null,
  )
  resetSidebarStores()
  useChatStore.setState({ sessions: {} })
  useLaneMoveStore.setState({ draft: null })
  useLanePrefsStore.setState({ lanes: DEFAULT_LANE_PREFS })
  usePullRequestsStore.setState({ byRepo: {} })
  useSessionsStore.setState({
    live: {},
    unread: {},
    pinned: [],
    seenSessions: {},
    bulkDelete: null,
    disk: { '/repo': [meta(1), meta(2)] },
    laneMarkers: { '/repo/s1.jsonl': '🐙', '/repo/s2.jsonl': '🦊', '/other/s9.jsonl': '' },
    refreshMissing: vi.fn().mockResolvedValue(undefined),
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function openPicker(title: string): Promise<HTMLElement> {
  await act(async () =>
    root.render(
      <>
        <Sidebar workspacePath="/repo" />
        <ContextMenuHost />
      </>,
    ),
  )
  await act(async () => {})
  const row = [...container.querySelectorAll('[data-testid=session-row]')].find((r) =>
    r.textContent?.includes(title),
  )!
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  const item = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid=context-menu] button'),
  ].find((b) => b.textContent?.startsWith('Lane marker'))!
  await act(async () => item.click())
  await act(async () => {})
  return document.querySelector<HTMLElement>('[role=dialog][aria-label="Lane marker"]')!
}
const used = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll('button.opacity-35')].map((b) => b.textContent)
const button = (dialog: HTMLElement, text: string) =>
  [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(text),
  )!

it('dims only the markers other lanes chose, never its own or a None', async () => {
  const dialog = await openPicker('Lane 1')
  await act(async () => {
    const search = dialog.querySelector<HTMLInputElement>('input')!
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(search, 'fox')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(used(dialog)).toContain('🦊')
  expect(used(dialog)).not.toContain('🐙')
})

it.each([
  ['Auto', null],
  ['None', ''],
] as const)('writes %s to the lane prefs by path', async (label, written) => {
  const dialog = await openPicker('Lane 1')
  await act(async () => button(dialog, label).click())
  expect(useSessionsStore.getState().laneMarkers['/repo/s1.jsonl']).toBe(
    written === null ? undefined : written,
  )
  expect(document.querySelector('[aria-label="Lane marker"]')).toBeNull()
})
