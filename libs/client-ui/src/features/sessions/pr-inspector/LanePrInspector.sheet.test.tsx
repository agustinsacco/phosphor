// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitInfo, SessionMeta } from '@shared/models'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { MOCK_LANE_PRS, mockPrDetail, mockPrSummaries } from '@/dev/mockPullRequests'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { usePrStatusStore } from '@/stores/prStatus'
import { usePrDetailStore } from '@/stores/prDetail'
import { usePromptStore } from '@/stores/prompt'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { appendToDraft, focusComposer } from '@/features/chat/composer/appendToDraft'
import { prRef, prSummary } from '../__fixtures__/pullRequests'
import { setLanePrOverride } from '../lanePrOverrides'
import { LanePrStatus } from '../LanePrStatus'

vi.mock('../lanePrOverrides', () => ({ setLanePrOverride: vi.fn() }))
vi.mock('@/features/chat/composer/appendToDraft', () => ({
  appendToDraft: vi.fn(),
  focusComposer: vi.fn(),
}))

const git: GitInfo = { isRepo: true, isWorktree: true, mainRepoPath: '/repo', branch: 'scratch' }
const meta = {
  path: '/sessions/a.jsonl',
  sessionId: 'a',
  cwd: '/repo/wt',
  createdAt: '2026-11-09T15:55:34.682Z',
  pullRequests: MOCK_LANE_PRS.a,
} as SessionMeta
const override = vi.mocked(setLanePrOverride)
let root: Root
let container: HTMLDivElement
let restore: () => void
let dispose: () => void

const pill = () => container.querySelector<HTMLButtonElement>('[data-testid="lane-pr-status"]')!
const sheet = () =>
  document.querySelector<HTMLElement>('[role="dialog"][aria-label="Pull request details"]')
const actions = () =>
  document.querySelector<HTMLElement>('[role="dialog"][aria-label="Pull request actions"]')
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
const buttons = (scope: ParentNode = document) => [
  ...scope.querySelectorAll<HTMLButtonElement>('button'),
]
const button = (name: string, scope: ParentNode = document) =>
  buttons(scope).find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '') === name)
const escape = () =>
  act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )

async function openSheet(): Promise<void> {
  await act(async () =>
    root.render(
      <PlatformProvider value={COMPACT_PLATFORM}>
        <LanePrStatus sessionId="a" sheet />
      </PlatformProvider>,
    ),
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  await act(async () => pill().click())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  useSessionsStore.setState({
    activeSessionId: 'a',
    live: { a: { phosphorId: 'a', workspacePath: '/repo/wt', diskPath: meta.path } },
    disk: { '/repo/wt': [meta] },
    gitByCwd: { '/repo/wt': git },
  })
  useChatStore.setState({ sessions: {} })
  useLanePrefsStore.getState().applyLanePrefs({ prStatus: true })
  usePullRequestsStore.setState({ byRepo: {}, available: true })
  usePrStatusStore.setState({ byKey: {} })
  usePrDetailStore.setState({ byKey: {} })
  usePromptStore.setState({ requests: [] })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local' })
  override.mockReset().mockResolvedValue(undefined)
  vi.mocked(appendToDraft).mockReset()
  vi.mocked(focusComposer).mockReset()
  const fake = createFakePhosphor({
    'gh:available': async () => true,
    'gh:prsForRepo': async () => ({
      byBranch: { other: { ...prSummary({ ref: prRef(12), number: 12 }) } },
      complete: true,
    }),
    'gh:prSummaries': mockPrSummaries,
    'gh:prDetail': mockPrDetail,
    'git:infoBatch': async () => ({ '/repo/wt': git }),
  })
  restore = installFakePhosphor(fake)
  dispose = fake.dispose
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('opens as a full-height sheet with segmented sections and a Close that returns to the pill', async () => {
  await openSheet()
  expect(pill().classList.contains('hit-slop')).toBe(true)
  const dialog = sheet()!
  expect(dialog.classList.contains('lane-pill-sheet')).toBe(true)
  expect(dialog.closest('[data-compact-sheet]')).not.toBeNull()
  expect(dialog.textContent).toContain('Pull requests')
  // The list holds focus on open, as on Desktop.
  expect(document.activeElement).toBe(options()[0])
  const tablist = dialog.querySelector('[role="tablist"]')!
  expect(tablist.getAttribute('data-segmented')).toBe('true')
  expect([...tablist.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
    'Overview',
    'Checks7',
    'Reviews5',
    'Threads4',
    'Activity',
  ])
  // Track lives in the overflow menu: no small targets in the list or the header.
  expect(button('Track a PR…', dialog)).toBeUndefined()
  expect(button('Track', dialog)).toBeUndefined()
  expect(dialog.querySelector('[data-testid="pr-inspector-track"]')).toBeNull()
  await act(async () => button('Close', dialog)!.click())
  expect(sheet()).toBeNull()
  expect(document.activeElement).toBe(pill())
})

it('keeps Track and Hide in the overflow sheet, and stays open on a failure', async () => {
  override.mockRejectedValueOnce(new Error('Take control first.'))
  await openSheet()
  await act(async () => button('More actions', sheet()!)!.click())
  expect(buttons(actions()!).map((b) => b.textContent)).toEqual([
    'Track a PR…',
    'Hide from this lane',
  ])
  await act(async () => button('Hide from this lane', actions()!)!.click())
  expect(override).toHaveBeenCalledExactlyOnceWith('a', 'hide', prRef(57))
  expect(actions()).toBeNull()
  expect(sheet()?.querySelector('[role="alert"]')?.textContent).toBe('Take control first.')
  // A suggestion is tracked from the same menu.
  await act(async () => options()[3]!.click())
  await act(async () => button('More actions', sheet()!)!.click())
  await act(async () => button('Track in this lane', actions()!)!.click())
  expect(override).toHaveBeenLastCalledWith('a', 'pin', prRef(61))
  expect(sheet()).not.toBeNull()
})

it('closes the overflow sheet before the inspector on Escape, and tracks by URL from it', async () => {
  await openSheet()
  await act(async () => button('More actions', sheet()!)!.click())
  await escape()
  expect(actions()).toBeNull()
  expect(sheet()).not.toBeNull()
  await act(async () => button('More actions', sheet()!)!.click())
  await act(async () => button('Track a PR…', actions()!)!.click())
  const request = usePromptStore.getState().requests[0]!
  expect(request.title).toBe('Track a pull request')
  await act(async () => usePromptStore.getState().dismiss(request, '#99'))
  expect(override).toHaveBeenCalledExactlyOnceWith('a', 'pin', prRef(99))
  await escape()
  expect(sheet()).toBeNull()
})

it('drafts a hand-off into the composer and closes the sheet, as on Desktop', async () => {
  await openSheet()
  await act(async () => button('Fix', sheet()!)!.click())
  expect(appendToDraft).toHaveBeenCalledExactlyOnceWith('a', expect.stringContaining('#57'))
  expect(focusComposer).toHaveBeenCalled()
  expect(sheet()).toBeNull()
})
