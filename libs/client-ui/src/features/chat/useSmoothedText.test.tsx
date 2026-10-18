// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSmoothedText } from './useSmoothedText'

/**
 * The hook's contract, driven with fake timers:
 *
 * - text present at MOUNT shows immediately (hydrated history and
 *   virtualizer re-mounts must never replay a typewriter),
 * - text arriving AFTER mount reveals progressively, not as one slab,
 * - a window with no rAF at all (the e2e suite's never-shown windows,
 *   background tabs) still completes via the timeout backstop,
 * - prefers-reduced-motion shows everything immediately.
 */

let root: Root | null = null
let container: HTMLDivElement | null = null
let lastRendered = ''

function Probe({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
  const shown = useSmoothedText(text, streaming)
  lastRendered = shown
  return <div data-testid="probe">{shown}</div>
}

function render(text: string, streaming: boolean): void {
  act(() => {
    root!.render(<Probe text={text} streaming={streaming} />)
  })
}

const CHUNK = 'x'.repeat(90)

let rafEnabled = true
let matchMediaMatches = false

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
  rafEnabled = true
  matchMediaMatches = false
  // jsdom's rAF is wall-clock based; route it through fake timers so
  // advanceTimersByTime drives frames, and let tests starve it entirely.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    if (!rafEnabled) return 0
    return setTimeout(() => cb(performance.now()), 16) as unknown as number
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
  })
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      get matches() {
        return matchMediaMatches
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useSmoothedText', () => {
  it('shows everything already present at mount — no typewriter replay', () => {
    render(CHUNK + CHUNK, true)
    expect(lastRendered).toHaveLength(180)
  })

  it('reveals post-mount growth progressively instead of as one slab', () => {
    render(CHUNK, true)
    render(CHUNK + CHUNK, true) // second provider chunk lands

    advance(100)
    const early = lastRendered.length
    expect(early).toBeGreaterThan(90) // moving…
    expect(early).toBeLessThan(180) // …but not a slab

    advance(2000)
    expect(lastRendered).toHaveLength(180) // and it completes
  })

  it('completes without rAF, via the timeout backstop', () => {
    rafEnabled = false
    render(CHUNK, true)
    render(CHUNK + CHUNK + CHUNK, false) // settled while hidden

    advance(3000)
    expect(lastRendered).toHaveLength(270)
  })

  it('shows full text immediately under prefers-reduced-motion', () => {
    matchMediaMatches = true
    render(CHUNK, true)
    render(CHUNK + CHUNK, true)
    expect(lastRendered).toHaveLength(180)
  })

  it('returns settled text verbatim with no animation machinery', () => {
    render('final answer', false)
    expect(lastRendered).toBe('final answer')
  })
})
