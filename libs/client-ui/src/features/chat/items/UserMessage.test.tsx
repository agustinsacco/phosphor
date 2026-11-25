// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { clockTime } from '@/lib/time'
import { REMOTE_UNAVAILABLE } from '@/stores/hostRefusals'
import { UserMessage } from './UserMessage'

// A lane whose Host owns the chat cannot rewind or fork, and the copy that says
// so belongs to this row. `vi.hoisted` because the mock factory runs while the
// imports below are still being evaluated.
const lane = vi.hoisted(() => ({ editable: true }))
vi.mock('../hostRewind', () => ({ useRewindAvailable: () => lane.editable }))

// Row renderers pull in the settings store, which reads matchMedia at module scope.
window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) as unknown as typeof window.matchMedia

const T = new Date('2026-08-09T15:04:00').getTime()
let root: Root | null = null
let container: HTMLDivElement | null = null

function render(text = 'fix the flake', timestamp?: number): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <UserMessage
        item={{ id: 'u1', kind: 'user', text, ...(timestamp === undefined ? {} : { timestamp }) }}
        sessionId="s1"
      />,
    )
  })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('user turn meta row', () => {
  it('shows the turn clock time without a hover', () => {
    const el = render('fix the flake', T)
    const time = [...el.querySelectorAll('[data-tooltip]')].find((n) =>
      n.textContent?.includes(':'),
    )
    expect(time?.textContent).toBe(clockTime(T))
    // Hover-hidden affordances never carry it: on a phone there is no hover, and
    // the hour is the thing a reader wants without hunting for it.
    expect(time?.closest('[data-testid="user-message"]')).toBeNull()
    expect(time?.className).not.toContain('opacity-0')
  })

  it('spells the whole timestamp out on hover', () => {
    const el = render('fix the flake', T)
    const tooltip = [...el.querySelectorAll('[data-tooltip]')]
      .find((n) => n.textContent?.includes(':'))
      ?.getAttribute('data-tooltip')
    expect(tooltip).toBe(new Date(T).toLocaleString())
  })

  it('keeps the actions until hover and the row at the same height', () => {
    const el = render('fix the flake', T)
    const hidden = el.querySelector('.opacity-0')
    expect(hidden?.querySelectorAll('button').length).toBeGreaterThan(0)
    // Fixed height in both states, so revealing them cannot nudge the transcript.
    expect(el.querySelector('h-4, [class*="h-4"]')).not.toBeNull()
  })

  it('says nothing when a turn has no time', () => {
    const el = render('fix the flake')
    expect(
      [...el.querySelectorAll('[data-tooltip]')].some((n) => n.textContent?.includes(':')),
    ).toBe(false)
  })

  it('says so when the Host owns the chat, instead of offering a silent no-op', () => {
    lane.editable = false
    try {
      const el = render()
      const disabled = [...el.querySelectorAll<HTMLButtonElement>('button')]
        .filter((b) => b.disabled)
        .map((b) => b.getAttribute('data-tooltip'))
      // Rewind and fork both name the Host as the reason; neither is a button
      // that does nothing when pressed.
      expect(disabled).toEqual([REMOTE_UNAVAILABLE, REMOTE_UNAVAILABLE])
    } finally {
      lane.editable = true
    }
  })
})
