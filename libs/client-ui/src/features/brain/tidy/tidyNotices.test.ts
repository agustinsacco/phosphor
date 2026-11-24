// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { mockBrainStatus } from '../mockBrainData'
import { useNotificationsStore } from '@/stores/notifications'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useLayoutStore } from '@/stores/layout'
import { createTidyNotices } from './tidyNotices'
import { useBrainNavigation } from '../brainNavigation'
import type { BrainAgentRun } from '@shared/brain-agent'

const run: BrainAgentRun = {
  id: 'run',
  state: 'running',
  total: 31,
  decided: 31,
  erased: 2,
  undoable: 29,
  queuedAt: 1,
  startedAt: 2,
  finishedAt: null,
  error: null,
  sessionPath: null,
  rulesChanged: false,
  automatic: false,
}
beforeEach(() => {
  useNotificationsStore.setState({ items: [], open: false })
  useExtensionUiStore.setState({ toasts: [] })
  useLayoutStore.setState({ page: null })
  useBrainNavigation.setState({ request: 0, target: null })
})
const enabled = () => {
  const s = mockBrainStatus()
  s.prefs.enabled = true
  return s
}
const notices = () => useNotificationsStore.getState().items
it('keeps startup and suggestion increases silent', () => {
  const observe = createTidyNotices(),
    status = enabled()
  observe(status)
  observe({
    ...status,
    agent: { ...status.agent, waiting: { ...status.agent.waiting, repeats: 10 } },
  })
  expect(notices()).toEqual([])
})
it('announces the result in the single Brain notice, opening What changed', async () => {
  const observe = createTidyNotices(),
    status = enabled()
  observe({ ...status, agent: { ...status.agent, run } })
  observe({ ...status, agent: { ...status.agent, run: { ...run, state: 'done', finishedAt: 50 } } })
  expect(notices()).toHaveLength(1)
  expect(notices()[0]!.message).toBe('Brain Agent decided 31 things and erased 2')
  await notices()[0]!.onOpen?.()
  expect(useBrainNavigation.getState().target).toEqual({ changes: true })
})
it('stays quiet when Brain is open and clears its notice when Brain is off', () => {
  const observe = createTidyNotices(),
    status = enabled()
  observe({ ...status, agent: { ...status.agent, run } })
  useLayoutStore.setState({ page: 'brain' })
  observe({ ...status, agent: { ...status.agent, run: { ...run, state: 'stopped' } } })
  expect(notices()).toEqual([])
  useLayoutStore.setState({ page: null })
  observe({ ...status, agent: { ...status.agent, run } })
  observe({ ...status, agent: { ...status.agent, run: { ...run, state: 'done' } } })
  expect(notices()).toHaveLength(1)
  observe(mockBrainStatus())
  expect(notices()).toEqual([])
})
it('keeps automatic folds outside Defrag in the same notice, and suppresses those inside it', () => {
  const observe = createTidyNotices(),
    status = enabled()
  observe(status)
  observe({ ...status, tidy: { ...status.tidy, automaticFolds: 3, newestAutomaticFoldAt: 10 } })
  expect(notices()[0]!.message).toBe('Brain folded 3 exact repeats')
  observe({
    ...status,
    agent: { ...status.agent, run },
    tidy: { ...status.tidy, automaticFolds: 6, newestAutomaticFoldAt: 20 },
  })
  expect(notices()[0]!.message).toBe('Brain folded 3 exact repeats')
  observe({ ...status, agent: { ...status.agent, run: { ...run, state: 'done' } } })
  expect(notices()).toHaveLength(1)
  expect(notices()[0]!.message).toBe('Brain Agent decided 31 things and erased 2')
})

it('marks a stopped Defrag notice as stopped while keeping its changes', () => {
  const observe = createTidyNotices(),
    status = enabled()
  observe({ ...status, agent: { ...status.agent, run } })
  observe({ ...status, agent: { ...status.agent, run: { ...run, state: 'stopped' } } })
  expect(notices()[0]).toMatchObject({
    kind: 'info',
    message: 'Brain Agent decided 31 things and erased 2 · stopped',
  })
})

it.each(['Ledger unavailable', null])('announces a failed Defrag as an error (%s)', (error) => {
  const observe = createTidyNotices(),
    status = enabled()
  observe({ ...status, agent: { ...status.agent, run } })
  observe({
    ...status,
    agent: { ...status.agent, run: { ...run, state: 'failed', decided: 0, erased: 0, error } },
  })
  expect(notices()[0]).toMatchObject({ kind: 'error', message: error ?? 'Defrag failed.' })
  expect(useExtensionUiStore.getState().toasts.at(-1)?.kind).toBe('error')
})
