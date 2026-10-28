import { describe, expect, it } from 'vitest'
import type { RpcSessionState } from '@phosphor/shared/rpc'
import { ALL_THINKING_LEVELS } from '@phosphor/shared/thinking'
import { piState } from './pi-results'

const state: RpcSessionState = {
  sessionId: 'pi-id',
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
}

describe('piState', () => {
  // A lane started at `max` failed creation as `internal`: pi reported its level and this refused it.
  it.each(ALL_THINKING_LEVELS)('accepts every thinking level pi reports: %s', (thinkingLevel) => {
    expect(piState({ ...state, thinkingLevel })).toEqual({ ...state, thinkingLevel })
  })
  it('refuses a thinking level pi does not have', () => {
    expect(piState({ ...state, thinkingLevel: 'extreme' })).toBeNull()
  })
})
