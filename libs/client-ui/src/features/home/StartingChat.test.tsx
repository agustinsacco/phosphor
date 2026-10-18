// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StartingChat } from './StartingChat'
import { USER_BUBBLE_CLASS } from '@/features/chat/userBubble'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('StartingChat', () => {
  // Regression: the echo hand-copied the transcript bubble's classes and missed
  // `break-words`, so a large paste with a long cookie or URL painted past the
  // bubble for as long as the branch was being created. jsdom cannot measure
  // layout (the e2e suite covers the transcript geometrically); what it can
  // pin is that the echo uses the same bubble, so the two cannot drift again.
  it('renders the message in the shared, wrapping user bubble', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root!.render(
        <StartingChat
          starting={{
            workspacePath: '/ws',
            prompt: `curl -b '${'x'.repeat(400)}'`,
            phase: 'branching',
          }}
        />,
      )
    })

    const bubble = container.querySelector<HTMLElement>('[data-testid="starting-chat-message"]')!
    expect(bubble.className).toBe(USER_BUBBLE_CLASS)
    expect(bubble.classList).toContain('break-words')
    // Backstop, matching the transcript scroller: nothing scrolls sideways.
    expect(bubble.closest('.overflow-y-auto')!.classList).toContain('overflow-x-hidden')
  })
})
