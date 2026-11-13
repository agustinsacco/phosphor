// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import type { SessionMeta } from '@shared/models'
import { prCheck, prRef, prSummary } from '@/features/sessions/__fixtures__/pullRequests'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { usePrInspectorStore } from '@/stores/prInspector'
import { usePrStatusStore } from '@/stores/prStatus'
import { useSessionsStore } from '@/stores/sessions'
import type { PrNotice } from './prNotice'
import { openPrLane, openPrNotice, runPrNoticeAction } from './prNoticeActions'

const mocks = vi.hoisted(() => ({
  navigateToLane: vi.fn(() => Promise.resolve(true)),
  appendToDraft: vi.fn(),
  focusComposer: vi.fn(),
}))
vi.mock('@/stores/remoteLanes', () => ({ navigateToLane: mocks.navigateToLane }))
vi.mock('@/features/chat/composer/appendToDraft', () => ({
  appendToDraft: mocks.appendToDraft,
  focusComposer: mocks.focusComposer,
}))

const meta = { path: '/s/a.jsonl', cwd: '/repo', mtimeMs: 0 } as Partial<SessionMeta> as SessionMeta
const notice: PrNotice = {
  key: prKey(prRef(57)),
  ref: prRef(57),
  lane: { path: '/s/a.jsonl', workspacePath: '/repo', title: 'Refactor auth module' },
  summary: prSummary(),
  changes: [],
}
const invoke = vi.fn()
const openDiskSession = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { phosphor: { invoke } })
  usePrInspectorStore.setState({ request: null })
  usePrStatusStore.setState({ byKey: {} })
  useExtensionUiStore.setState({ toasts: [] })
  openDiskSession.mockImplementation(() => {
    useSessionsStore.setState({ activeSessionId: 'p2' })
    return Promise.resolve('p2')
  })
  useSessionsStore.setState({
    live: {},
    disk: { '/repo': [meta] },
    activeSessionId: null,
    openDiskSession,
  })
})

it('goes to the running lane the way every lane notice does, then asks for the inspector', async () => {
  useSessionsStore.setState({
    live: { p1: { phosphorId: 'p1', workspacePath: '/repo', diskPath: '/s/a.jsonl' } },
  })
  await openPrNotice(notice)
  expect(mocks.navigateToLane).toHaveBeenCalledWith({ sessionId: 'p1' })
  expect(usePrInspectorStore.getState().request).toMatchObject({ sessionId: 'p1', key: notice.key })
})

it('opens a lane that is not running from its file', async () => {
  await openPrNotice(notice)
  expect(openDiskSession).toHaveBeenCalledWith('/repo', meta)
  expect(usePrInspectorStore.getState().request).toMatchObject({ sessionId: 'p2', key: notice.key })
})

it('says so when the lane is gone, and asks for nothing', async () => {
  useSessionsStore.setState({ disk: { '/repo': [] } })
  expect(await openPrLane(notice)).toBeNull()
  expect(useExtensionUiStore.getState().toasts[0]).toMatchObject({
    kind: 'error',
    message: 'Refactor auth module is no longer on This Mac.',
  })
})

it('drafts a hand-off from the PR as it reads now, in the lane, and never sends it', async () => {
  usePrStatusStore.setState({
    byKey: {
      [notice.key]: {
        summary: prSummary({ checkRuns: [prCheck('unit', 'failure', true)] }),
        attemptedAt: 1,
        fetchedAt: 1,
      },
    },
  })
  await runPrNoticeAction(notice, {
    kind: 'handoff',
    handoff: 'fix-checks',
    label: 'Ask agent to fix',
  })
  expect(mocks.appendToDraft).toHaveBeenCalledWith('p2', expect.stringContaining(': unit.'))
  expect(mocks.focusComposer).toHaveBeenCalled()
  expect(usePrInspectorStore.getState().request).toBeNull()
  expect(invoke).not.toHaveBeenCalledWith('pi:command', expect.anything(), expect.anything())
})

it('opens a ready PR on GitHub', async () => {
  await runPrNoticeAction(notice, { kind: 'github', label: 'Open on GitHub' })
  expect(invoke).toHaveBeenCalledWith('app:openExternal', notice.summary.url)
  expect(openDiskSession).not.toHaveBeenCalled()
})
