// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAutoResizeTextarea } from './useAutoResizeTextarea'

let root: Root | null = null
let container: HTMLDivElement | null = null
let textarea: HTMLTextAreaElement | null = null
let observers: { callback: ResizeObserverCallback }[] = []
/** scrollHeight jsdom reports is always 0; steer it per assertion. */
let mockScrollHeight = 0

beforeEach(() => {
  observers = []
  mockScrollHeight = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        observers.push(this)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        observers = observers.filter((o) => o !== this)
      }
    },
  )
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  textarea = null
  document.body.innerHTML = ''
})

function setMockScrollHeight(value: number): void {
  mockScrollHeight = value
  if (textarea) {
    Object.defineProperty(textarea, 'scrollHeight', { value, configurable: true })
  }
}

/** Simulates a column-width change: the live observer fires, same text. */
function fireResize(): void {
  const observer = observers.at(-1)
  expect(observer, 'a live ResizeObserver').toBeDefined()
  act(() => {
    observer!.callback([], observer as unknown as ResizeObserver)
  })
}

function TextareaHarness({ text }: { text: string }): React.JSX.Element {
  const ref = createRef<HTMLTextAreaElement>()
  useAutoResizeTextarea(ref, text, 240)
  return (
    <textarea
      ref={(node) => {
        ref.current = node
        textarea = node
        if (node) {
          Object.defineProperty(node, 'scrollHeight', {
            value: mockScrollHeight,
            configurable: true,
          })
        }
      }}
      rows={1}
      value={text}
      onChange={() => undefined}
    />
  )
}

let setText: (text: string) => void

function renderHarness(initial: string): void {
  const Stateful = (): React.JSX.Element => {
    const [text, set] = useState(initial)
    setText = set
    return <TextareaHarness text={text} />
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<Stateful />)
  })
}

describe('useAutoResizeTextarea', () => {
  it('sizes to scrollHeight when it is below the cap', () => {
    setMockScrollHeight(80)
    renderHarness('short')
    expect(textarea!.style.height).toBe('80px')
  })

  it('caps the height at maxHeight for long wrapped text', () => {
    setMockScrollHeight(600)
    renderHarness('a very long line '.repeat(50))
    expect(textarea!.style.height).toBe('240px')
  })

  it('grows with the text and shrinks back down', () => {
    setMockScrollHeight(60)
    renderHarness('one line')
    expect(textarea!.style.height).toBe('60px')

    setMockScrollHeight(200)
    act(() => setText('a long line that wraps over several lines\n'.repeat(10)))
    expect(textarea!.style.height).toBe('200px')

    setMockScrollHeight(500)
    act(() => setText('even longer '.repeat(200)))
    expect(textarea!.style.height).toBe('240px')

    setMockScrollHeight(40)
    act(() => setText('x'))
    expect(textarea!.style.height).toBe('40px')
  })

  it('re-measures when the element is resized (column width change)', () => {
    setMockScrollHeight(100)
    renderHarness('text')
    expect(textarea!.style.height).toBe('100px')

    // Same text, narrower column: more wrapping.
    setMockScrollHeight(180)
    fireResize()
    expect(textarea!.style.height).toBe('180px')
  })

  it('disconnects the observer on unmount', () => {
    setMockScrollHeight(80)
    renderHarness('text')
    expect(observers).toHaveLength(1)
    act(() => root!.unmount())
    expect(observers).toHaveLength(0)
  })
})
