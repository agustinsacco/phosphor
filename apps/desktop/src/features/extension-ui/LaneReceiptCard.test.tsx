// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { Toast } from '@/stores/extensionUi'
import { LaneReceiptCard, openReceiptAction } from './LaneReceiptCard'
const mocks = vi.hoisted(() => ({
  activeSessionId: 'lane',
  live: {},
  page: null,
  setRightPane: vi.fn(),
  dismissToast: vi.fn(),
}))
vi.mock('@/stores/sessions', () => ({ useSessionsStore: { getState: () => mocks } }))
vi.mock('@/stores/layout', () => ({ useLayoutStore: { getState: () => mocks } }))
vi.mock('@/stores/extensionUi', () => ({ useExtensionUiStore: { getState: () => mocks } }))
vi.mock('@/stores/machines', () => ({
  useMachinesStore: (selector: (s: { machines: [] }) => unknown) => selector({ machines: [] }),
}))
const toast = (): Toast => ({
  id: 1,
  kind: 'success',
  title: 'Lane',
  message: 'Finished',
  sessionId: 'lane',
  openLabel: 'Open lane',
  leaving: false,
  bump: 0,
  receipt: {
    machine: 'This Mac',
    at: new Date().toISOString(),
    facts: {
      title: 'Lane',
      repository: 'repo',
      branch: 'main',
      settledAt: null,
      durationMs: 1000,
      files: 1,
      added: 2,
      removed: 1,
      tests: 'passed',
      artifacts: 1,
      excerpt: 'Done',
      outcome: 'done',
    },
  },
})
const container = document.createElement('div')
afterEach(() => {
  container.innerHTML = ''
  vi.clearAllMocks()
  mocks.activeSessionId = 'lane'
  mocks.page = null
})
it('renders receipt facts and hides empty facts independently', async () => {
  const root = createRoot(container)
  const t = toast()
  await act(async () => root.render(<LaneReceiptCard toast={t} />))
  for (const text of [
    'This Mac',
    'repo · ⎇ main',
    '1 file',
    '+2',
    '-1',
    'tests pass',
    '1 artifact',
    'View changes',
  ])
    expect(container.textContent).toContain(text)
  const facts = t.receipt?.facts
  if (!facts) throw new Error('fixture')
  Object.assign(facts, {
    repository: null,
    branch: null,
    durationMs: null,
    files: 0,
    tests: null,
    artifacts: 0,
  })
  await act(async () => root.render(<LaneReceiptCard toast={t} />))
  for (const text of ['⎇', 'file', 'tests pass', 'artifact', 'View changes', '1s'])
    expect(container.textContent).not.toContain(text)
  expect(container.querySelector('[data-testid="receipt-facts"]')).toBeNull()
  facts.outcome = 'error'
  facts.excerpt = 'failed'
  await act(async () => root.render(<LaneReceiptCard toast={t} />))
  expect(container.textContent).toContain('Stopped: failed')
  expect(container.textContent).toContain('Retry')
  expect(container.querySelector('button[aria-label="Open lane: Lane"]')).not.toBeNull()
  await act(async () => root.unmount())
})
it('renders an old Host fallback with machine context and no fabricated facts', async () => {
  const root = createRoot(container)
  const t = toast()
  t.title = 'bee1 · Lane'
  t.message = 'finished'
  t.receipt = { machine: 'bee1', machineId: 'host', laneId: 'remote', at: new Date().toISOString() }
  await act(async () => root.render(<LaneReceiptCard toast={t} />))
  expect(container.textContent).toContain('bee1')
  expect(container.querySelector('strong')?.textContent).toBe('Lane')
  expect(container.querySelector('[data-testid="receipt-facts"]')).toBeNull()
  expect(container.textContent).not.toContain('View changes')
  expect(container.querySelector('button[aria-label="Open lane: bee1 · Lane"]')).not.toBeNull()
  await act(async () => root.unmount())
})
it('waits for navigation, changes only the destination, skips failures, and Retry sends nothing', async () => {
  const t = toast()
  let resolve: () => void = () => {}
  t.onOpen = () =>
    new Promise<void>((r) => {
      resolve = r
    })
  const pending = openReceiptAction(t, 'changes')
  expect(mocks.setRightPane).not.toHaveBeenCalled()
  resolve()
  await pending
  expect(mocks.setRightPane).toHaveBeenCalledWith('changes', 'lane')
  mocks.setRightPane.mockClear()
  t.onOpen = async () => {
    throw new Error('failed')
  }
  await openReceiptAction(t, 'changes')
  expect(mocks.setRightPane).not.toHaveBeenCalled()
  t.onOpen = () => {
    mocks.activeSessionId = 'other'
  }
  await openReceiptAction(t, 'changes')
  expect(mocks.setRightPane).not.toHaveBeenCalled()
  mocks.activeSessionId = 'lane'
  t.onOpen = () => {}
  const composer = document.createElement('textarea')
  composer.setAttribute('aria-label', 'Chat message')
  document.body.append(composer)
  await openReceiptAction(t, 'retry')
  expect(document.activeElement).toBe(composer)
  composer.remove()
})
