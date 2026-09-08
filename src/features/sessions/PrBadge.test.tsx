// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GhPullRequest } from '@shared/models'
import { PrBadge } from './PrBadge'

let root: Root | null = null
let container: HTMLDivElement | null = null
let invoke: ReturnType<typeof vi.fn>

function render(ui: React.ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(ui)
  })
}

const badge = (): HTMLElement =>
  document.querySelector('[data-testid="session-pr-badge"]') as HTMLElement

const click = (element: HTMLElement): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

const pr = (over: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number: 412,
  title: 'Ship it',
  state: 'OPEN',
  url: 'https://github.com/o/r/pull/412',
  ...over,
})

beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(undefined)
  ;(window as unknown as { phosphor: unknown }).phosphor = { invoke }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

describe('PrBadge', () => {
  it('opens the PR in the browser when clicked', () => {
    render(<PrBadge pr={pr()} />)
    click(badge())
    expect(invoke).toHaveBeenCalledWith('app:openExternal', 'https://github.com/o/r/pull/412')
  })

  it('does not let the click reach the row, which would swap the session', () => {
    const rowClick = vi.fn()
    render(
      <button onClick={rowClick}>
        <PrBadge pr={pr()} />
      </button>,
    )
    click(badge())
    expect(invoke).toHaveBeenCalledOnce()
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('reads as clickable', () => {
    render(<PrBadge pr={pr()} />)
    expect(badge().className).toContain('cursor-pointer')
    expect(badge().getAttribute('role')).toBe('link')
    expect(badge().getAttribute('aria-label')).toMatch(/Open on GitHub/)
  })

  it('is not a tab stop — one per lane would double the sidebar’s tab order', () => {
    render(<PrBadge pr={pr()} />)
    expect(badge().getAttribute('tabindex')).toBe('-1')
  })

  it('still carries the state variant for scanning', () => {
    render(<PrBadge pr={pr({ state: 'MERGED' })} />)
    expect(badge().getAttribute('data-variant')).toBe('merged')
  })

  it('links to the PR it renders, not a stale one', () => {
    render(<PrBadge pr={pr({ number: 7, url: 'https://github.com/o/r/pull/7' })} />)
    click(badge())
    expect(invoke).toHaveBeenCalledWith('app:openExternal', 'https://github.com/o/r/pull/7')
  })

  it('flags a conflicting PR distinctly from a failing one', () => {
    render(<PrBadge pr={pr({ mergeable: 'CONFLICTING' })} />)
    expect(badge().getAttribute('data-variant')).toBe('conflict')
  })
})

describe('PrBadge with no PR', () => {
  it('renders the inert fallback instead of throwing', () => {
    render(<PrBadge pr={null} />)
    expect(badge().getAttribute('data-variant')).toBe('no-pr')
  })

  it('is not a link — there is nothing to open', () => {
    render(<PrBadge pr={null} />)
    expect(badge().getAttribute('role')).toBeNull()
    expect(badge().className).not.toContain('cursor-pointer')
  })

  it('does not call out to open anything when clicked', () => {
    render(<PrBadge pr={null} />)
    click(badge())
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('theming', () => {
  it('never uses a `dark:` utility', () => {
    // Phosphor themes with a `.dark` class and defines no @custom-variant dark,
    // so Tailwind's `dark:` keys off the OS preference instead of the app
    // theme. Hover state must derive from the chip's own token colour.
    render(<PrBadge pr={pr()} />)
    expect(badge().className).not.toMatch(/(^|\s)dark:/)
  })
})
