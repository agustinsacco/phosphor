// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import { prRef, prSummary } from '@/features/sessions/__fixtures__/pullRequests'
import { useExtensionUiStore, type ToastOptions } from '@/stores/extensionUi'
import { useNotificationsStore } from '@/stores/notifications'
import { usePrStatusStore } from '@/stores/prStatus'
import { ToastCard } from './ToastCard'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
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
  useExtensionUiStore.getState().setToastsPaused('hover', false)
  vi.useRealTimers()
})

function show(options: ToastOptions): HTMLElement {
  act(() => {
    useExtensionUiStore.getState().notify(options)
    const [toast] = useExtensionUiStore.getState().toasts
    root.render(
      <ol>
        <ToastCard toast={toast!} />
      </ol>,
    )
  })
  return container.querySelector<HTMLElement>('[data-testid="toast"]')!
}

const card = (toast: HTMLElement) => toast.querySelector<HTMLElement>('.toast-card')!
const bar = (toast: HTMLElement) => toast.querySelector<HTMLElement>('[data-testid="toast-bar"]')!

it.each([
  ['error', 'bg-danger', 'alert'],
  ['warning', 'bg-warning', null],
  ['success', 'bg-success', null],
  ['info', 'bg-border-strong', null],
] as const)('a %s toast is the square card with its tone on the left edge', (kind, tone, role) => {
  const toast = show({ message: 'Disk full', kind })
  expect(toast.dataset.kind).toBe(kind)
  expect(card(toast).className).toContain('rounded-sm')
  expect(card(toast).className).toContain('border-border-strong')
  expect(card(toast).className).toContain('bg-surface-raised')
  expect(bar(toast).className).toContain(tone)
  expect(card(toast).getAttribute('role')).toBe(role)
  expect(toast.textContent).toContain('Disk full')
})

it('opens a titled notice from its body and dismisses from its own button', () => {
  const onOpen = vi.fn()
  const toast = show({ message: 'Finished.', title: 'CI lane', onOpen, openLabel: 'Open lane' })
  const open = toast.querySelector<HTMLButtonElement>('[data-testid="toast-open"]')!
  expect(open.getAttribute('aria-label')).toBe('Open lane: CI lane')
  act(() => open.click())
  expect(onOpen).toHaveBeenCalledOnce()
  expect(useExtensionUiStore.getState().toasts[0]!.leaving).toBe(true)
})

it('holds its clock while the pointer is on it', () => {
  const toast = show({ message: 'Disk full', kind: 'error' })
  act(() => {
    card(toast).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  act(() => {
    vi.advanceTimersByTime(20_000)
  })
  expect(useExtensionUiStore.getState().toasts[0]!.leaving).toBe(false)
})

it('edges a lane receipt in its machine colour and keeps its actions', () => {
  const toast = show({
    message: 'Finished',
    kind: 'success',
    title: 'Lane',
    sessionId: 'lane',
    onOpen: vi.fn(),
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
        artifacts: 0,
        excerpt: 'Done',
        outcome: 'done',
      },
    },
  })
  expect(bar(toast).style.background).not.toBe('')
  expect(toast.textContent).toContain('tests pass')
  const names = Array.from(toast.querySelectorAll('button')).map((b) => b.textContent)
  expect(names).toEqual(expect.arrayContaining(['Open lane', 'View changes']))
})

it('shows a PR notice with its verdict tone, place, since line and actions', () => {
  const key = prKey(prRef(57))
  const toast = show({
    key: `pr:${key}`,
    kind: 'error',
    title: '#57 Rocky review failed (not required)',
    message: 'Refactor auth module · Phosphor#57',
    openLabel: 'Open lane',
    onOpen: vi.fn(),
    pr: {
      key,
      ref: prRef(57),
      lane: { path: '/s/a.jsonl', workspacePath: '/repo', title: 'Refactor auth module' },
      summary: prSummary(),
      changes: [
        {
          kind: 'checks-failed',
          text: 'Rocky review failed (not required)',
          tone: 'bad',
          important: true,
        },
        { kind: 'approved', text: '@kim approved', tone: 'good', important: true },
      ],
    },
  })
  expect(bar(toast).className).toContain('bg-danger')
  expect(toast.querySelector('[data-testid="pr-notice-glyph"]')!.getAttribute('data-tone')).toBe(
    'failing',
  )
  expect(toast.textContent).toContain('Refactor auth module · Phosphor#57')
  expect(toast.textContent).toContain('Since you looked:')
  const names = Array.from(toast.querySelectorAll('button')).map((b) => b.textContent)
  expect(names).toEqual(expect.arrayContaining(['Open lane', 'Ask agent to fix']))
})
