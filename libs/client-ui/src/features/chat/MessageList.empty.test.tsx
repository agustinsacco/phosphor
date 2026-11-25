// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { hostLaneSession, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { MessageList } from './MessageList'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})

it.each(['history notice', 'Host message count'])(
  'does not invite a first prompt with a %s',
  async (evidence) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const id = mockRemoteInfo.sessionId
    const chat = useChatStore.getState()
    chat.ensure(id)
    useSessionsStore.setState({ live: hostLaneSession({ self: true }).live })
    const el = document.createElement('div')
    const root = createRoot(el)
    try {
      await act(async () => root.render(<MessageList sessionId={id} />))
      expect(el.textContent).toContain('Describe a task to begin')
      act(() => {
        if (evidence === 'history notice')
          chat.setHistoryNotice(id, 'This conversation is too large to preview.')
        else chat.setMeta(id, { ...mockMeta, sessionId: id })
      })
      expect(el.textContent).not.toContain('Describe a task to begin')
    } finally {
      act(() => root.unmount())
      useChatStore.setState({ sessions: {} })
      useSessionsStore.setState({ live: {} })
      vi.unstubAllGlobals()
    }
  },
)

const mockMeta = {
  isStreaming: false,
  isCompacting: false,
  thinkingLevel: 'off',
  steeringMode: 'all',
  followUpMode: 'all',
  autoCompactionEnabled: true,
  messageCount: 1,
  pendingMessageCount: 0,
} as const
