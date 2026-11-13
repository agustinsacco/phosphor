// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import type { GitInfo, SessionMeta } from '@shared/models'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { MOCK_LANE_PRS, mockPrDetail, mockPrSummaries } from '@/dev/mockPullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useLayoutStore } from '@/stores/layout'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { usePrStatusStore } from '@/stores/prStatus'
import { usePrDetailStore } from '@/stores/prDetail'
import { usePrInspectorStore } from '@/stores/prInspector'
import { usePrSeenStore } from '@/stores/prSeen'
import { usePromptStore } from '@/stores/prompt'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { appendToDraft, focusComposer } from '@/features/chat/composer/appendToDraft'
import { prCheck, prRef, prSummary } from '../__fixtures__/pullRequests'
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
const detailRead = vi.fn(mockPrDetail)
const external = vi.fn(async (_url: string) => {})
let root: Root
let container: HTMLDivElement
let restore: () => void
let dispose: () => void

const pill = () => container.querySelector<HTMLButtonElement>('[data-testid="lane-pr-status"]')!
const details = () => document.querySelector('[aria-label="Pull request details"]')
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
const selected = () => document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
const header = () => document.querySelector('[aria-label="Selected pull request"]')!
const button = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => {
    const label = b.getAttribute('aria-label') ?? b.textContent ?? ''
    return typeof name === 'string' ? label === name : name.test(label)
  })!
const tab = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
    t.textContent?.startsWith(name),
  )!
const press = (target: Element, key: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })

async function openInspector(): Promise<void> {
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
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
  useLayoutStore.setState({ sidebarVisible: false })
  useLanePrefsStore.getState().applyLanePrefs({ prStatus: true })
  usePullRequestsStore.setState({ byRepo: {}, available: true })
  usePrStatusStore.setState({ byKey: {} })
  usePrDetailStore.setState({ byKey: {} })
  usePrInspectorStore.setState({ request: null })
  usePrSeenStore.setState({ byKey: {} })
  usePromptStore.setState({ requests: [] })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local' })
  override.mockReset().mockResolvedValue(undefined)
  vi.mocked(appendToDraft).mockReset()
  vi.mocked(focusComposer).mockReset()
  detailRead.mockClear()
  external.mockReset().mockResolvedValue(undefined)
  const fake = createFakePhosphor({
    'gh:available': async () => true,
    // Discovery saw one PR on another branch: it names the lane's repository.
    'gh:prsForRepo': async () => ({
      byBranch: { other: { ...prSummary({ ref: prRef(12), number: 12 }) } },
      complete: true,
    }),
    'gh:prSummaries': mockPrSummaries,
    'gh:prDetail': detailRead,
    'git:infoBatch': async () => ({ '/repo/wt': git }),
    'app:openExternal': external,
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

it('leads the pill with the PR that needs you most, its rail and +N', async () => {
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  expect(pill().textContent).toBe('#57+1')
  expect(pill().getAttribute('data-variant')).toBe('failing')
  expect(pill().getAttribute('aria-label')).toBe(
    'Pull request #57: Rocky review failed (not required). 1 more pull request.',
  )
  const rail = [...pill().querySelectorAll('[data-testid="pr-rail"] i')]
  expect(rail.map((i) => i.getAttribute('data-state'))).toEqual(['done', 'fail', 'part', 'wait'])
})

it('groups the lane’s PRs, suggestions after, and moves the selection with the arrow keys', async () => {
  await openInspector()
  const groups = [...document.querySelectorAll('[role="listbox"] [role="group"]')]
  expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
    'This lane',
    'Reviewing',
    'Mentioned',
  ])
  expect(options().map((o) => o.textContent?.match(/#\d+/)?.[0])).toEqual([
    '#57',
    '#58',
    '#55',
    '#61',
    '#39',
  ])
  // The list is one tab stop and holds focus on open.
  expect(options().filter((o) => o.tabIndex === 0)).toEqual([selected()])
  expect(document.activeElement).toBe(selected())
  await press(selected()!, 'ArrowDown')
  expect(selected()?.textContent).toContain('#58')
  expect(document.activeElement).toBe(selected())
  expect(header().textContent).toContain('Add a knowledge-service CLI with typed commands')
  await press(selected()!, 'End')
  expect(selected()?.textContent).toContain('#39')
  expect(header().textContent).toContain('Merged')
  await press(selected()!, 'Home')
  expect(selected()?.textContent).toContain('#57')
  await act(async () => options()[2]!.click())
  expect(header().textContent).toContain('agustinsacco/Phosphor#55')
})

it('reads detail for the shown PR, and again every 30s while it is open', async () => {
  await openInspector()
  expect(detailRead).toHaveBeenCalledWith(prRef(57), undefined)
  const before = detailRead.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(detailRead.mock.calls.length).toBe(before + 1)
  await act(async () => options()[4]!.click())
  expect(detailRead).toHaveBeenLastCalledWith(prRef(39), undefined)
  const merged = detailRead.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  // A merged PR changes no more: read once, not watched.
  expect(detailRead.mock.calls.length).toBe(merged)
})

it('tabs between sections with the arrow keys and lists failing checks first', async () => {
  await openInspector()
  expect(tab('Checks').textContent).toBe('Checks7')
  expect(tab('Threads').textContent).toBe('Threads4')
  await press(tab('Overview'), 'ArrowRight')
  expect(tab('Checks').getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(tab('Checks'))
  const panel = document.querySelector('[role="tabpanel"]')!
  const rows = () =>
    [...panel.querySelectorAll('[data-testid="pr-check"]')].map((r) => r.getAttribute('data-state'))
  expect(rows()[0]).toBe('failure')
  expect(panel.textContent).toContain('Write commands need an explicit opt-in (cli/src/run.ts:248)')
  expect(rows()).toHaveLength(6)
  await act(async () => button('+1 passing').click())
  expect(rows()).toHaveLength(7)
  await act(async () => button(/Open the Rocky review log/).click())
  expect(external).toHaveBeenCalledWith('https://github.com/agustinsacco/Phosphor/runs/1')
  await press(tab('Checks'), 'End')
  expect(tab('Activity').getAttribute('aria-selected')).toBe('true')
  expect(panel.textContent).toContain('@agustinsacco asked @core-reviewers to review')
})

it('drafts each checklist hand-off for the agent, focuses the composer and closes', async () => {
  await openInspector()
  const checklist = document.querySelector('[data-testid="pr-checklist"]')!
  expect(checklist.textContent).toContain('6 passed; Rocky review failed (not required)')
  expect(checklist.textContent).toContain('Waiting on @core-reviewers. 2 approved')
  expect(checklist.textContent).toContain('4 unresolved of 12')
  expect(checklist.textContent).toContain('Blocked: needs a code-owner review')
  await act(async () => button(/Show checks details/).click())
  expect(checklist.querySelectorAll('[data-testid="pr-check"]').length).toBeGreaterThan(0)
  await act(async () => button('Fix').click())
  expect(appendToDraft).toHaveBeenCalledExactlyOnceWith(
    'a',
    expect.stringContaining(
      'Fix the failing check on #57 (https://github.com/agustinsacco/Phosphor/pull/57): Rocky review (not required) ("Write commands need an explicit opt-in")',
    ),
  )
  expect(focusComposer).toHaveBeenCalled()
  expect(details()).toBeNull()
  await act(async () => pill().click())
  await act(async () => button('Nudge').click())
  expect(vi.mocked(appendToDraft).mock.lastCall?.[1]).toContain(
    'asking @core-reviewers to review #57',
  )
})

it('tracks a suggestion in one click, and from the header for the keyboard', async () => {
  await openInspector()
  const plus = document.querySelectorAll<HTMLElement>('[data-testid="pr-inspector-track"]')
  expect(plus).toHaveLength(3)
  await act(async () => plus[0]!.click())
  expect(override).toHaveBeenCalledExactlyOnceWith('a', 'pin', prRef(55))
  // Once tracked, the inspector shows it.
  expect(selected()?.textContent).toContain('#55')
  await act(async () => options()[3]!.click())
  await act(async () => button('Track').click())
  expect(override).toHaveBeenLastCalledWith('a', 'pin', prRef(61))
})

it('keeps a Track or Hide failure inline and the inspector open', async () => {
  override.mockRejectedValue(new Error('Only a live lane can track pull requests.'))
  await openInspector()
  await act(async () => button('More actions').click())
  await act(async () => button('Hide from this lane').click())
  expect(override).toHaveBeenCalledWith('a', 'hide', prRef(57))
  expect(details()?.querySelector('[role="alert"]')?.textContent).toBe(
    'Only a live lane can track pull requests.',
  )
  expect(details()).not.toBeNull()
})

it('tracks a PR by number in the lane’s repository through the app prompt', async () => {
  await openInspector()
  await act(async () => button('Track a PR…').click())
  const request = usePromptStore.getState().requests[0]!
  expect(request.title).toBe('Track a pull request')
  // A click in the dialog is outside the popup; it must not close it.
  await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(details()).not.toBeNull()
  await act(async () => usePromptStore.getState().dismiss(request, '#99'))
  expect(override).toHaveBeenCalledExactlyOnceWith('a', 'pin', prRef(99))
  await act(async () => button('Track a PR…').click())
  await act(async () =>
    usePromptStore.getState().dismiss(usePromptStore.getState().requests[0]!, 'not a pr'),
  )
  expect(details()?.querySelector('[role="alert"]')?.textContent).toContain(
    'Paste a pull request URL',
  )
})

it('says what changed since you looked, and records the new look after two seconds', async () => {
  vi.setSystemTime(Date.parse('2026-11-13T05:00:00Z'))
  const key = prKey(prRef(57))
  const seenAt = Date.now() - 2 * 3_600_000
  usePrSeenStore.setState({
    byKey: {
      [key]: {
        seenAt,
        summary: prSummary({
          checkRuns: [prCheck('build', 'pending', true)],
          checks: { passed: 0, failed: 0, pending: 1, total: 1 },
          approvedBy: ['mara'],
        }),
      },
    },
  })
  await openInspector()
  const since = () => document.querySelector('[data-testid="pr-inspector-since"]')
  expect(since()?.textContent).toBe(
    'Since you looked (2h ago): Rocky review failed (not required) · @devon approved',
  )
  await press(tab('Overview'), 'End')
  expect(document.querySelectorAll('[role="tabpanel"] li[data-new]').length).toBe(2)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(usePrSeenStore.getState().byKey[key]!.seenAt).toBeGreaterThan(seenAt)
  // The strip stays for this look; the next one starts from here.
  expect(since()).not.toBeNull()
})

it('answers a request to open on one PR, then clears it', async () => {
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  await act(async () => usePrInspectorStore.getState().open('b', prKey(prRef(58))))
  expect(details()).toBeNull()
  await act(async () => usePrInspectorStore.getState().open('a', prKey(prRef(58))))
  expect(details()).not.toBeNull()
  expect(selected()?.textContent).toContain('#58')
  expect(usePrInspectorStore.getState().request).toBeNull()
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(details()).toBeNull()
  expect(document.activeElement).toBe(pill())
})
