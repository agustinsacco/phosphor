// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyBrainTidyPage, type BrainTidyPage } from '@shared/brain-tidy'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { mockBrainStatus } from '../mockBrainData'
import { useNotificationsStore } from '@/stores/notifications'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useLayoutStore } from '@/stores/layout'
import { createTidyNotices } from './tidyNotices'
import { useTidyNavigation } from './tidyNavigation'

let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
const list = vi.fn<() => Promise<BrainTidyPage>>()
beforeEach(() => {
  vi.useFakeTimers()
  useNotificationsStore.setState({ items: [], open: false })
  useExtensionUiStore.setState({ toasts: [] })
  useLayoutStore.setState({ page: null })
  useTidyNavigation.setState({ request: 0, tab: 'knowledge', recent: false })
  list
    .mockReset()
    .mockResolvedValue({
      ...emptyBrainTidyPage(),
      run: {
        state: 'done',
        suggestions: 8,
        folded: 2,
        checked: 12,
        total: 12,
        startedAt: 100,
        finishedAt: 200,
        message: null,
        error: null,
      },
    })
  fake = createFakePhosphor({ 'brain:tidy': list })
  restore = installFakePhosphor(fake)
})
afterEach(() => {
  restore()
  fake.dispose()
  vi.useRealTimers()
})
const enabled = () => {
  const s = mockBrainStatus()
  s.prefs.enabled = true
  return s
}
const notices = () => useNotificationsStore.getState().items
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
it('treats existing suggestions and automatic folds at startup as a silent baseline', () => {
  const observe = createTidyNotices(),
    status = enabled()
  status.tidy = {
    ...status.tidy,
    open: 12,
    automaticFolds: 4,
    newestSuggestionAt: 10,
    newestAutomaticFoldAt: 10,
  }
  observe(status)
  observe(structuredClone(status))
  expect(notices()).toEqual([])
  expect(useExtensionUiStore.getState().toasts).toEqual([])
})
it('replaces one rolling notice only on an increase, and opens Brain on Tidy', async () => {
  const observe = createTidyNotices(),
    status = enabled()
  observe(status)
  observe({ ...status, tidy: { ...status.tidy, open: 3, newestSuggestionAt: 10 } })
  observe({ ...status, tidy: { ...status.tidy, open: 5, newestSuggestionAt: 20 } })
  expect(notices()).toHaveLength(1)
  expect(notices()[0]).toMatchObject({ key: 'brain:tidy', message: 'Brain has 5 things to tidy' })
  expect(useExtensionUiStore.getState().toasts.filter((t) => !t.leaving)).toHaveLength(1)
  observe({ ...status, tidy: { ...status.tidy, open: 4, newestSuggestionAt: 30 } })
  expect(notices()[0]!.message).toBe('Brain has 5 things to tidy')
  await notices()[0]!.onOpen?.()
  expect(useLayoutStore.getState().page).toBe('brain')
  expect(useTidyNavigation.getState()).toMatchObject({ request: 1, recent: false })
})
it('keeps one automatic-fold toast in the panel opening Recent changes', async () => {
  const observe = createTidyNotices(),
    status = enabled()
  observe(status)
  observe({ ...status, tidy: { ...status.tidy, automaticFolds: 3, newestAutomaticFoldAt: 10 } })
  expect(notices()[0]!.message).toBe('Brain folded 3 exact repeats')
  await notices()[0]!.onOpen?.()
  expect(useTidyNavigation.getState().recent).toBe(true)
})
it('announces a finished click only while elsewhere, without a second suggestions notice', async () => {
  const observe = createTidyNotices(),
    status = enabled()
  observe(status)
  observe({ ...status, tidy: { ...status.tidy, running: true } })
  observe({ ...status, tidy: { ...status.tidy, open: 8, newestSuggestionAt: 10 } })
  await flush()
  expect(notices()).toHaveLength(1)
  expect(notices()[0]!.message).toBe('Brain Tidy found 8 things to tidy and folded 2 exact repeats')
  useLayoutStore.setState({ page: 'brain' })
  useTidyNavigation.setState({ tab: 'tidy' })
  observe({ ...status, tidy: { ...status.tidy, running: true } })
  observe(status)
  await flush()
  expect(list).toHaveBeenCalledOnce()
})
it('offers a route to Retry when the completion read fails, then succeeds on the next run', async () => {
  list.mockRejectedValueOnce(new Error('Tidy result unavailable'))
  const observe = createTidyNotices(),
    status = enabled()
  observe(status)
  observe({ ...status, tidy: { ...status.tidy, running: true } })
  observe(status)
  await flush()
  expect(notices()[0]!.message).toContain('Open Tidy to retry')
  observe({ ...status, tidy: { ...status.tidy, running: true } })
  observe(status)
  await flush()
  expect(notices()).toHaveLength(1)
  expect(notices()[0]!.message).toContain('found 8')
})
it('ignores an older completion reply and says nothing when disabled or unsupported', async () => {
  let resolve!: (page: BrainTidyPage) => void
  list.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const observe = createTidyNotices(),
    status = enabled()
  observe(status)
  observe({ ...status, tidy: { ...status.tidy, running: true } })
  observe(status)
  observe({ ...status, tidy: { ...status.tidy, running: true } })
  resolve({
    ...emptyBrainTidyPage(),
    run: {
      state: 'failed',
      checked: 0,
      total: 0,
      suggestions: 0,
      folded: 0,
      startedAt: 1,
      finishedAt: 2,
      message: null,
      error: 'Old error',
    },
  })
  await flush()
  expect(notices()).toEqual([])
  observe({
    ...status,
    supported: false,
    tidy: { ...status.tidy, open: 12, newestSuggestionAt: 10 },
  })
  observe(mockBrainStatus())
  expect(notices()).toEqual([])
})
it('removes Tidy notices when Brain is switched off and re-enabling establishes a new baseline', () => {
  const observe = createTidyNotices(),
    status = enabled()
  observe(status)
  const newer = { ...status, tidy: { ...status.tidy, open: 3, newestSuggestionAt: 10 } }
  observe(newer)
  expect(notices()).toHaveLength(1)
  observe({ ...newer, prefs: { ...newer.prefs, enabled: false } })
  expect(notices()).toEqual([])
  observe(newer)
  expect(notices()).toEqual([])
})
