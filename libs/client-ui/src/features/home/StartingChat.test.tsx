// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StartingChat } from './StartingChat'
import { USER_BUBBLE_CLASS } from '@/features/chat/userBubble'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { SLOW_START_MS } from './startingStatus'

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

describe('StartingChat for a Host lane', () => {
  it('follows the Host step live and says when one runs long', () => {
    vi.useFakeTimers()
    const host = (phase: 'branching' | 'starting') => ({
      [MOCK_HOST_ID]: {
        ...mockRemoteHosts[MOCK_HOST_ID]!,
        laneStarts: [{ repositoryId: 'r', branch: 'b', phase }],
      },
    })
    useRemoteLanesStore.setState({ hosts: host('branching') })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root!.render(
        <StartingChat
          starting={{
            prompt: 'Fix it',
            phase: 'branching',
            remote: { hostId: MOCK_HOST_ID, repositoryId: 'r', draftKey: 'k' },
          }}
        />,
      ),
    )
    const phase = () => container!.querySelector('[data-testid="starting-chat-phase"]')!.textContent
    const slow = () => container!.querySelector('[data-testid="starting-chat-slow"]')
    expect(phase()).toBe(`Creating branch on ${MOCK_HOST_ID}…`)
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(SLOW_START_MS - 1)
    })
    expect(slow()).toBeNull()
    act(() => useRemoteLanesStore.setState({ hosts: host('starting') }))
    expect(phase()).toBe(`Starting session on ${MOCK_HOST_ID}…`)
    // A new step restarts the clock.
    act(() => {
      vi.advanceTimersByTime(SLOW_START_MS - 1)
    })
    expect(slow()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(slow()?.textContent).toContain(`${MOCK_HOST_ID} is slow to answer.`)
    // A step that comes back starts a fresh wait instead of being slow at once.
    act(() => useRemoteLanesStore.setState({ hosts: host('branching') }))
    act(() => useRemoteLanesStore.setState({ hosts: host('starting') }))
    expect(slow()).toBeNull()
    vi.useRealTimers()
  })
})
