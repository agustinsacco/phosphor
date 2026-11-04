// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { ContextMenuHost } from '@/components/ContextMenu'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Sidebar } from './Sidebar'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

const meta = (n: number, lastActivityAt = ''): SessionMeta => ({
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
  lastActivityAt,
})
const UNSEEN_AT = '2026-09-10T12:00:00.000Z'
// Lane 2 was last seen before its latest activity: it is unseen.
const SEEN = { '/repo/s2.jsonl': Date.parse(UNSEEN_AT) - 60_000 }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: {
      invoke,
      onUpdateEvent: () => () => {},
      onAccountChanged: () => () => {},
      onRoutinesChanged: () => () => {},
      onSessionsChanged: () => () => {},
    },
  })
  invoke
    .mockReset()
    .mockImplementation(async (channel: string) =>
      channel === 'app:getPrefs'
        ? { seenSessions: SEEN }
        : channel === 'routines:laneIndex'
          ? {}
          : channel === 'git:listWorktrees'
            ? []
            : channel === 'sessions:list'
              ? [meta(1), meta(2, UNSEEN_AT)]
              : null,
    )
  useMachinesStore.setState({ remoteEnabled: false, machines: [], adding: false })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local', error: null })
  useWorkspacesStore.setState({
    recents: [{ path: '/repo', name: 'repo', lastOpenedAt: 0 }],
    hydrated: true,
  })
  useSessionsStore.setState({
    live: { live1: { phosphorId: 'live1', workspacePath: '/repo', diskPath: '/repo/s1.jsonl' } },
    unread: {},
    pinned: [],
    seenSessions: SEEN,
    bulkDelete: null,
    disk: { '/repo': [meta(1), meta(2, UNSEEN_AT)] },
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

async function menuFor(title: string): Promise<string[]> {
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
  return [...document.querySelectorAll('[data-testid=context-menu] button')].map(
    (b) => b.textContent ?? '',
  )
}

it("calls stopping a live This Mac lane Stop, as a Host lane's menu does", async () => {
  const rows = await menuFor('Lane 1')
  expect(rows.some((label) => label.startsWith('Stop'))).toBe(true)
  expect(rows.some((label) => label.startsWith('Suspend'))).toBe(false)
  expect(rows).not.toContain('Mark read')
})

it('offers Mark read on an unseen This Mac lane, and it marks the lane seen', async () => {
  const rows = await menuFor('Lane 2')
  expect(rows).toContain('Mark read')
  const markRead = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid=context-menu] button'),
  ].find((b) => b.textContent === 'Mark read')!
  act(() => markRead.click())
  expect(useSessionsStore.getState().seenSessions['/repo/s2.jsonl']).toBeGreaterThan(
    Date.parse(UNSEEN_AT),
  )
  expect(invoke).toHaveBeenCalledWith('app:markSessionSeen', '/repo/s2.jsonl')
})
