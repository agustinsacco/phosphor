import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from './chat'

/**
 * pi answers a prompt an extension command consumed with `disposition:
 * "handled"` and starts no run, so nothing else would ever clear the booting
 * strip or confirm the optimistic bubble.
 */
describe('chat store promptHandled', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {} })
  })

  const session = (id: string) => {
    const found = useChatStore.getState().sessions[id]
    if (!found) throw new Error(`no chat session ${id}`)
    return found
  }

  it('drops the optimistic bubble and the booting state', () => {
    const chat = useChatStore.getState()
    chat.ensure('s')
    chat.addUserMessage('s', 'hello')
    chat.applyEvent('s', {
      type: 'message_end',
      message: { role: 'user', content: 'hello', timestamp: 1 },
    })
    chat.addUserMessage('s', '/mcp')
    expect(session('s').promptSentAt).not.toBeNull()

    chat.promptHandled('s', '/mcp')

    expect(session('s').promptSentAt).toBeNull()
    expect(
      session('s').items.map((item) => (item.kind === 'user' ? item.text : item.kind)),
    ).toEqual(['hello'])
  })

  it('leaves a confirmed message with the same text alone', () => {
    const chat = useChatStore.getState()
    chat.ensure('s')
    chat.addUserMessage('s', '/mcp')
    chat.applyEvent('s', {
      type: 'message_end',
      message: { role: 'user', content: '/mcp', timestamp: 1 },
    })

    chat.promptHandled('s', '/mcp')

    expect(session('s').items).toHaveLength(1)
  })
})
