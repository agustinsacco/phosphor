// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { laneIsBeingDeleted, useSessionsStore, type BulkDeleteProgress } from '@/stores/sessions'
import { BulkDeleteProgressPopover } from './BulkDeleteModal'

const lanes = [
  { path: '/sessions/a.jsonl', title: 'First lane' },
  { path: '/sessions/b.jsonl', title: 'Second lane' },
]

function progress(overrides: Partial<BulkDeleteProgress> = {}): BulkDeleteProgress {
  return {
    total: 2,
    done: 0,
    current: 'First lane',
    currentPath: '/sessions/a.jsonl',
    lanes,
    results: [],
    running: true,
    cancelled: false,
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderPopover(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<BulkDeleteProgressPopover />))
}

beforeEach(() => {
  vi.useFakeTimers()
  useSessionsStore.setState({ bulkDelete: null })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  document.body.innerHTML = ''
  root = null
  container = null
  useSessionsStore.setState({ bulkDelete: null })
  vi.useRealTimers()
})

describe('BulkDeleteProgressPopover', () => {
  it('is a compact non-blocking notification that expands to per-lane progress', () => {
    useSessionsStore.setState({ bulkDelete: progress() })
    renderPopover()

    const popover = document.querySelector('[data-testid="bulk-delete-progress"]')
    const toggle = document.querySelector('[data-testid="bulk-delete-toggle"]') as HTMLButtonElement
    expect(popover).not.toBeNull()
    expect(document.querySelector('[data-modal-overlay]')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.textContent).toContain('Deleting 1 of 2')
    expect(document.body.textContent).not.toContain('Second lane')

    act(() => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain('First lane')
    expect(document.body.textContent).toContain('Second lane')
    expect(document.body.textContent).toContain('Stop')
  })

  it('collapses on completion, then fades and dismisses itself', () => {
    useSessionsStore.setState({ bulkDelete: progress() })
    renderPopover()
    const toggle = document.querySelector('[data-testid="bulk-delete-toggle"]') as HTMLButtonElement
    act(() => toggle.click())

    act(() => {
      useSessionsStore.setState({
        bulkDelete: progress({
          done: 2,
          current: '',
          currentPath: '',
          results: lanes.map((lane) => ({ ...lane, ok: true })),
          running: false,
        }),
      })
    })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.textContent).toContain('Deleted 2 lanes')

    act(() => vi.advanceTimersByTime(4_000))
    expect(document.querySelector('[data-testid="bulk-delete-progress"]')?.className).toContain(
      'opacity-0',
    )

    act(() => vi.advanceTimersByTime(250))
    expect(useSessionsStore.getState().bulkDelete).toBeNull()
    expect(document.querySelector('[data-testid="bulk-delete-progress"]')).toBeNull()
  })
})

describe('laneIsBeingDeleted', () => {
  it('disables queued and successfully removed lanes, but releases failures', () => {
    expect(laneIsBeingDeleted(progress(), lanes[0]!.path)).toBe(true)
    expect(laneIsBeingDeleted(progress(), lanes[1]!.path)).toBe(true)

    const withResults = progress({
      done: 2,
      results: [
        { ...lanes[0]!, ok: true },
        { ...lanes[1]!, ok: false, error: 'worktree kept' },
      ],
    })
    expect(laneIsBeingDeleted(withResults, lanes[0]!.path)).toBe(true)
    expect(laneIsBeingDeleted(withResults, lanes[1]!.path)).toBe(false)
  })

  it('releases queued lanes after Stop while the current lane stays disabled', () => {
    const stopping = progress({ cancelled: true })
    expect(laneIsBeingDeleted(stopping, lanes[0]!.path)).toBe(true)
    expect(laneIsBeingDeleted(stopping, lanes[1]!.path)).toBe(false)
    expect(laneIsBeingDeleted({ ...stopping, running: false }, lanes[0]!.path)).toBe(false)
  })
})
