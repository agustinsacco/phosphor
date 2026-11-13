// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import { prRef, prSummary } from '@/features/sessions/__fixtures__/pullRequests'
import type { PrChange } from '@/features/sessions/prChanges'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useNotificationsStore } from '@/stores/notifications'
import { usePrStatusStore } from '@/stores/prStatus'
import { NotificationDrawer } from './NotificationDrawer'
import type { PrNotice } from './prNotice'

const actions = vi.hoisted(() => ({
  openPrNotice: vi.fn((_notice: unknown) => Promise.resolve()),
  runPrNoticeAction: vi.fn((_notice: unknown, _action: unknown) => Promise.resolve()),
}))
vi.mock('./prNoticeActions', () => actions)

let root: Root
let container: HTMLDivElement

const change = (text: string, tone: PrChange['tone']): PrChange => ({
  kind: 'checks-failed',
  text,
  tone,
  important: true,
})
const notice = (changes: PrChange[]): PrNotice => ({
  key: prKey(prRef(57)),
  ref: prRef(57),
  lane: { path: '/s/a.jsonl', workspacePath: '/repo', title: 'Refactor auth module' },
  summary: prSummary(),
  changes,
})

function raise(pr: PrNotice): void {
  useExtensionUiStore.getState().notify({
    key: `pr:${pr.key}`,
    pr,
    kind: 'error',
    title: `#57 ${pr.changes[0]!.text}`,
    message: 'Refactor auth module · Phosphor#57',
    openLabel: 'Open lane',
    onOpen: () => actions.openPrNotice(pr),
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  actions.openPrNotice.mockClear()
  actions.runPrNoticeAction.mockClear()
  useNotificationsStore.setState({ items: [], open: false })
  useExtensionUiStore.setState({ toasts: [] })
  usePrStatusStore.setState({ byKey: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const row = () => container.querySelector<HTMLElement>('[data-testid="notification-row"]')!
const button = (name: string) =>
  Array.from(row().querySelectorAll('button')).find((b) => b.textContent === name)

it('shows the verdict, the headline, where it is and what changed since you looked', () => {
  act(() => {
    raise(
      notice([
        change('Rocky review failed (not required)', 'bad'),
        change('@kim approved', 'good'),
      ]),
    )
    root.render(<NotificationDrawer />)
  })
  const glyph = row().querySelector('[data-testid="pr-notice-glyph"]')!
  expect(glyph.getAttribute('data-tone')).toBe('failing')
  expect(row().textContent).toContain('#57 Rocky review failed (not required)')
  expect(row().textContent).toContain('Refactor auth module · Phosphor#57')
  expect(row().querySelector('[data-testid="pr-notice-since"]')?.textContent).toBe(
    'Since you looked: Rocky review failed (not required) · @kim approved',
  )
  expect(button('Open lane')).toBeDefined()
  expect(button('Ask agent to fix')).toBeDefined()
})

it('says nothing more than the headline for a single change, and follows the PR as it reads now', () => {
  act(() => {
    raise(notice([change('Rocky review failed (not required)', 'bad')]))
    root.render(<NotificationDrawer />)
  })
  expect(row().querySelector('[data-testid="pr-notice-since"]')).toBeNull()
  act(() =>
    usePrStatusStore.setState({
      byKey: {
        [prKey(prRef(57))]: {
          summary: prSummary({ state: 'MERGED' }),
          attemptedAt: 1,
          fetchedAt: 1,
        },
      },
    }),
  )
  expect(row().querySelector('[data-testid="pr-notice-glyph"]')!.getAttribute('data-tone')).toBe(
    'merged',
  )
  expect(button('Ask agent to fix')).toBeUndefined()
  expect(button('Open lane')).toBeDefined()
})

it('opens the lane from the row or its button, hands off from the other, and is seen after', () => {
  const pr = notice([change('Rocky review failed (not required)', 'bad')])
  act(() => {
    raise(pr)
    root.render(<NotificationDrawer />)
  })
  act(() => button('Ask agent to fix')!.click())
  expect(actions.runPrNoticeAction).toHaveBeenCalledWith(expect.objectContaining({ key: pr.key }), {
    kind: 'handoff',
    handoff: 'fix-checks',
    label: 'Ask agent to fix',
  })
  expect(row().hasAttribute('data-seen')).toBe(true)

  act(() => button('Open lane')!.click())
  act(() => row().querySelector<HTMLButtonElement>('button[aria-label^="Open lane: #57"]')!.click())
  expect(actions.openPrNotice).toHaveBeenCalledTimes(2)
})
