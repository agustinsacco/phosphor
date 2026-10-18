import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@shared/rpc'
import { outcomeForMessages } from './outcome'

describe('routine outcomes', () => {
  const message: AgentMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Created a report.' }],
    stopReason: 'stop',
  }
  it('never equates an agent reply with verified success', () => {
    expect(outcomeForMessages([message], false)).toEqual({
      status: 'finished',
      summary: 'Created a report.',
      reason: expect.stringContaining('unverified'),
    })
  })
  it('flags tool errors even when the agent says done', () => {
    expect(outcomeForMessages([message], true).reason).toContain('tool errors')
  })
  it('rejects empty replies, errors, and aborted output', () => {
    expect(outcomeForMessages([], false).status).toBe('failed')
    expect(outcomeForMessages([{ ...message, content: [] }], false).status).toBe('failed')
    expect(
      outcomeForMessages(
        [{ ...message, stopReason: 'error', errorMessage: 'Provider failed' }],
        false,
      ).reason,
    ).toBe('Provider failed')
    expect(outcomeForMessages([{ ...message, stopReason: 'aborted' }], false).status).toBe('failed')
  })
})
