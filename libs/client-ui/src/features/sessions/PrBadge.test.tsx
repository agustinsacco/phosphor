// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { blockedOnOwners, prCheck, prRef, prSummary } from './__fixtures__/pullRequests'
import { lanePr } from './__fixtures__/lanePr'
import type { LanePr } from './lanePrs'
import { prVerdict } from './prVerdict'
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

const badge = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="session-pr-badge"]')
const beads = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-testid="session-pr-bead"]'),
]

const click = (element: HTMLElement): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** #57 fails an optional bot; #58 is green and waits on code owners. */
const failing = lanePr(prSummary())
const review = lanePr(blockedOnOwners(58))
const green = [prCheck('build', 'success', true)]
const of = (number: number, patch: Parameters<typeof prSummary>[0] = {}): LanePr =>
  lanePr(prSummary({ ref: prRef(number), number, ...patch }))

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
  it('renders nothing for a lane with no PR of its own', () => {
    render(<PrBadge prs={[]} />)
    expect(badge()).toBeNull()
  })

  it('draws one bead per PR in the order given, lead first, tagged with the lead’s tone', () => {
    render(<PrBadge prs={[failing, review]} />)
    expect(beads().map((bead) => bead.dataset.tone)).toEqual(['failing', 'review'])
    expect(badge()?.dataset.variant).toBe('failing')
    // Two fit: the only count is the narrow row's.
    expect(badge()?.textContent).toBe('+1')
  })

  it('caps the beads at three and counts the rest as +N', () => {
    render(<PrBadge prs={[1, 2, 3, 4, 5].map((n) => of(n))} />)
    expect(beads()).toHaveLength(3)
    const counts = [...badge()!.querySelectorAll('span:not([data-testid])')]
    const wide = counts.filter((count) => !count.className.includes('hidden '))
    expect(wide.map((count) => count.textContent)).toEqual(['+2'])
  })

  it('keeps only the lead bead and counts the rest on a narrow row', () => {
    render(<PrBadge prs={[1, 2, 3, 4, 5].map((n) => of(n))} />)
    const narrowOnly = /@max-\[10\.5rem\]\/lane-line:hidden/
    expect(beads().map((bead) => narrowOnly.test(bead.className))).toEqual([false, true, true])
    const narrowCount = [...badge()!.querySelectorAll('span')].find((span) =>
      span.className.includes('@max-[10.5rem]/lane-line:inline'),
    )
    expect(narrowCount?.textContent).toBe('+4')
  })

  it('lists every PR on its own line in one tooltip, and says the same to a screen reader', () => {
    render(<PrBadge prs={[failing, review]} />)
    const lines = [
      '#57 Failing · Rocky review failed (not required)',
      '#58 In review · Waiting on code owners @knowledge-owners',
    ]
    expect(badge()?.dataset.tooltip).toBe(lines.join('\n'))
    expect(badge()?.getAttribute('aria-label')).toBe(`Pull requests: ${lines.join('. ')}`)
  })

  it('gives every tone its own glyph shape, so colour is never the only signal', () => {
    const cases: [LanePr, string | null][] = [
      [failing, 'failing'],
      [of(2, { mergeable: 'CONFLICTING', checkRuns: green }), 'conflict'],
      [of(3, { checkRuns: [...green, prCheck('e2e', 'pending', true)] }), 'pending'],
      [of(4, { checkRuns: green, reviewDecision: 'CHANGES_REQUESTED' }), 'blocked'],
      [review, 'review'],
      [of(5, { checkRuns: green, reviewDecision: 'APPROVED', threads: null }), 'ready'],
      [of(6, { state: 'MERGED' }), 'merged'],
      [of(7, { state: 'CLOSED' }), 'closed'],
      [of(8, { state: 'DRAFT' }), null],
    ]
    for (const [lane, glyph] of cases) {
      render(<PrBadge prs={[lane]} />)
      const bead = beads()[0]!
      expect(bead.dataset.tone).toBe(lane.verdict.tone)
      expect(bead.querySelector('svg')?.dataset.glyph ?? null).toBe(glyph)
      act(() => root?.unmount())
      document.body.innerHTML = ''
    }
  })

  it('outlines a draft with a dashed border instead of a glyph', () => {
    render(<PrBadge prs={[of(8, { state: 'DRAFT' })]} />)
    expect(beads()[0]?.className).toContain('border-dashed')
  })

  it('opens the bead’s own PR on GitHub, without the click reaching the row', () => {
    const rowClick = vi.fn()
    render(
      <button onClick={rowClick}>
        <PrBadge prs={[failing, review]} />
      </button>,
    )
    click(beads()[1]!)
    expect(invoke).toHaveBeenCalledWith(
      'app:openExternal',
      'https://github.com/agustinsacco/Phosphor/pull/58',
    )
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('opens a PR whose status is still unread, from its ref', () => {
    const unread: LanePr = { ...failing, pr: undefined, verdict: prVerdict(undefined) }
    render(<PrBadge prs={[unread]} />)
    expect(beads()[0]?.dataset.tone).toBe('unknown')
    click(beads()[0]!)
    expect(invoke).toHaveBeenCalledWith(
      'app:openExternal',
      'https://github.com/agustinsacco/Phosphor/pull/57',
    )
  })

  it('keeps each bead a mouse-only link: one tab stop per PR would flood the sidebar', () => {
    render(<PrBadge prs={[failing, review]} />)
    for (const bead of beads()) {
      expect(bead.getAttribute('role')).toBe('link')
      expect(bead.getAttribute('tabindex')).toBe('-1')
    }
    expect(badge()?.className).toMatch(/\bml-auto\b.*\bshrink-0\b|\bshrink-0\b.*\bml-auto\b/)
  })
})

describe('theming', () => {
  it('never uses a `dark:` utility', () => {
    // Phosphor themes with a `.dark` class and defines no @custom-variant dark,
    // so Tailwind's `dark:` keys off the OS preference instead of the app
    // theme. Hover state must derive from the bead's own token colour.
    render(<PrBadge prs={[failing, review, of(3, { state: 'DRAFT' })]} />)
    expect(document.body.innerHTML).not.toMatch(/(^|\s|")dark:/)
  })
})
