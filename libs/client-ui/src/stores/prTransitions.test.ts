// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import type { GhPrSummary, SessionMeta } from '@shared/models'
import { prCheck, prRef, prSummary } from '@/features/sessions/__fixtures__/pullRequests'
import { useExtensionUiStore } from './extensionUi'
import { useLanePrefsStore } from './lanePrefs'
import { useNotificationsStore } from './notifications'
import { usePrStatusStore, type PrStatusEntry } from './prStatus'
import { useSessionsStore } from './sessions'
import { attachPrTransitions } from './prTransitions'

const openPrNotice = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@/features/notifications/prNoticeActions', () => ({ openPrNotice }))

const invoke = vi.fn()
let detach: () => void

const green = (number: number): GhPrSummary =>
  prSummary({
    ref: prRef(number),
    checkRuns: [prCheck('build', 'success', true), prCheck('unit', 'success', true)],
    checks: { passed: 2, failed: 0, pending: 0, total: 2 },
    approvedBy: [],
  })
const failing = (pr: GhPrSummary, name: string): GhPrSummary => ({
  ...pr,
  checkRuns: (pr.checkRuns ?? []).map((c) => (c.name === name ? { ...c, state: 'failure' } : c)),
})
const approvedBy = (pr: GhPrSummary, name: string): GhPrSummary => ({
  ...pr,
  approvedBy: [...pr.approvedBy, name],
})

function answer(summary: GhPrSummary, patch: Partial<PrStatusEntry> = {}): void {
  const key = prKey(summary.ref)
  usePrStatusStore.setState((s) => ({
    byKey: {
      ...s.byKey,
      [key]: {
        summary,
        coverage: { state: 'found', checkedAt: 1, attemptedAt: 1 },
        attemptedAt: 1,
        fetchedAt: 1,
        failed: false,
        ...patch,
      },
    },
  }))
}

const lane = {
  path: '/s/a.jsonl',
  cwd: '/repo',
  name: 'Refactor auth module',
  cost: 0,
  lastActivityAt: '',
  mtimeMs: 1,
  pullRequests: {
    opened: [prRef(57), prRef(58)],
    branches: [],
    reviewing: [prRef(55)],
    mentioned: [],
    pinned: [],
    hidden: [],
  },
} as Partial<SessionMeta> as SessionMeta

const items = () => useNotificationsStore.getState().items
const notifyCalls = () => invoke.mock.calls.filter(([channel]) => channel === 'app:notify')

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset().mockResolvedValue(false)
  openPrNotice.mockClear()
  Object.assign(window, { phosphor: { invoke } })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  useNotificationsStore.setState({ items: [], open: false })
  useExtensionUiStore.setState({ toasts: [] })
  usePrStatusStore.setState({ byKey: {} })
  useSessionsStore.setState({ disk: { '/repo': [lane] }, live: {}, gitByCwd: {} })
  useLanePrefsStore.getState().applyLanePrefs({ prStatus: true })
  detach = attachPrTransitions()
})

afterEach(() => {
  detach()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('takes the first answer as a baseline, then raises important changes only', () => {
  answer(green(57))
  expect(items()).toHaveLength(0)
  answer({ ...green(57), headSha: 'f00d' })
  expect(items()).toHaveLength(0)
  answer(failing({ ...green(57), headSha: 'f00d' }, 'unit'))
  expect(items().map((item) => [item.key, item.title, item.message, item.kind])).toEqual([
    [`pr:${prKey(prRef(57))}`, '#57 unit failed', 'Refactor auth module · Phosphor#57', 'error'],
  ])
  expect(useExtensionUiStore.getState().toasts.map((toast) => toast.title)).toEqual([
    '#57 unit failed',
  ])
})

it('treats status known before it started as the baseline', () => {
  detach()
  answer(green(57))
  detach = attachPrTransitions()
  answer(approvedBy(green(57), 'kim'))
  expect(items().map((item) => item.title)).toEqual(['#57 @kim approved'])
})

it('raises nothing for a PR the lane only reviews', () => {
  answer(green(55))
  answer(failing(green(55), 'unit'))
  expect(items()).toHaveLength(0)
})

it('replaces one notice per PR, keeping what changed until it is seen', () => {
  answer(green(57))
  answer(green(58))
  answer(approvedBy(green(57), 'kim'))
  answer(failing(approvedBy(green(57), 'kim'), 'unit'))
  answer(approvedBy(green(58), 'lee'))
  const [pr58, pr57] = items()
  expect(pr57!.title).toBe('#57 unit failed')
  expect(pr57!.pr!.changes.map((c) => c.text)).toEqual(['unit failed', '@kim approved'])
  expect(pr58!.pr!.changes.map((c) => c.text)).toEqual(['@lee approved'])
  expect(items()).toHaveLength(2)

  useNotificationsStore.getState().markSeen([pr57!.id])
  answer(approvedBy(failing(approvedBy(green(57), 'kim'), 'unit'), 'ana'))
  expect(items()[0]!.pr!.changes.map((c) => c.text)).toEqual(['@ana approved'])
  expect(items()[0]!.seenAt).toBeUndefined()
})

it('ignores reads that did not answer, and keeps the baseline across them', () => {
  answer(green(57))
  answer(failing(green(57), 'unit'), { failed: true })
  answer(failing(green(57), 'unit'), {
    coverage: { state: 'unavailable', checkedAt: 0, attemptedAt: 2 },
  })
  expect(items()).toHaveLength(0)
  answer(failing(green(57), 'unit'))
  expect(items().map((item) => item.title)).toEqual(['#57 unit failed'])
})

it('stays quiet with PR status off, without replaying it when turned back on', () => {
  useLanePrefsStore.getState().applyLanePrefs({ prStatus: false })
  answer(green(57))
  answer(failing(green(57), 'unit'))
  useLanePrefsStore.getState().applyLanePrefs({ prStatus: true })
  answer({ ...failing(green(57), 'unit'), headSha: 'f00d' })
  expect(items()).toHaveLength(0)
})

it('posts a native notification only while Phosphor is in the background', async () => {
  answer(green(57))
  answer(failing(green(57), 'unit'))
  expect(notifyCalls()).toHaveLength(0)

  vi.mocked(document.hasFocus).mockReturnValue(false)
  invoke.mockResolvedValue(true)
  answer(failing(failing(green(57), 'unit'), 'build'))
  expect(notifyCalls()).toEqual([
    ['app:notify', { title: '#57 build failed', body: 'Refactor auth module · Phosphor' }],
  ])
  await vi.waitFor(() => expect(openPrNotice).toHaveBeenCalledOnce())
  expect(openPrNotice.mock.calls[0]).toMatchObject([{ key: prKey(prRef(57)) }])
  // Clicking it is looking at it: the entry is seen and its card goes.
  expect(items()[0]!.seenAt).toBeDefined()
  expect(useExtensionUiStore.getState().toasts.every((toast) => toast.leaving)).toBe(true)
})
