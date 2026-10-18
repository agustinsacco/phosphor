// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Same stubs as ErrorBlock.test.tsx: importing MessageItem pulls in the
// settings store (matchMedia) and MenuRow's scroll-into-view, both at module
// scope.
window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) as unknown as typeof window.matchMedia
Element.prototype.scrollIntoView = vi.fn()

const { MessageItemView } = await import('./MessageItem')

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderPendingTurn(): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <MessageItemView
        row={{
          kind: 'item',
          id: 'a1',
          item: { id: 'a1', kind: 'assistant', blocks: [], streaming: true },
        }}
        tools={{}}
        hideThinking={false}
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

describe('empty streaming assistant turn', () => {
  it('holds a caret seat for the reply and never a second Beacon', () => {
    const el = renderPendingTurn()
    // The Beacon belongs to the composer strip, which reports the run with its
    // timer and token count. Two of them for one turn is the double-loading
    // this row was changed to avoid.
    expect(el.querySelector('.phosphor-loader')).toBeNull()
    expect(el.querySelector('.streaming-cursor')).not.toBeNull()
  })

  it('still announces the wait to a screen reader', () => {
    const el = renderPendingTurn()
    const status = el.querySelector('[role="status"]')
    expect(status?.textContent).toBe('Waiting for a response')
  })
})
