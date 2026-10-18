// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLingering } from './useLingering'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null
let latest: ReturnType<typeof useLingering<string>> | null = null

function Probe({ value }: { value: string | null }): null {
  latest = useLingering(value, 200)
  return null
}

function render(value: string | null): void {
  act(() => root!.render(<Probe value={value} />))
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.useRealTimers()
})

describe('useLingering', () => {
  it('holds the last value while it leaves, then lets go', () => {
    render('a')
    expect(latest).toEqual({ value: 'a', leaving: false })
    render(null)
    expect(latest).toEqual({ value: 'a', leaving: true })
    act(() => vi.advanceTimersByTime(200))
    expect(latest).toEqual({ value: null, leaving: false })
  })

  it('a new value interrupts a leaving one', () => {
    render('a')
    render(null)
    render('b')
    expect(latest).toEqual({ value: 'b', leaving: false })
    act(() => vi.advanceTimersByTime(500))
    expect(latest).toEqual({ value: 'b', leaving: false })
  })
})
