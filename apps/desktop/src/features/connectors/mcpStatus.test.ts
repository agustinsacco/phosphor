import { describe, expect, it } from 'vitest'
import { STATE_DOT, stateLabel } from './mcpStatus'

describe('stateLabel', () => {
  it('counts tools only for a server that answered', () => {
    expect(stateLabel({ state: 'connected', tools: ['a', 'b'] })).toBe('Up · 2 tools')
    expect(stateLabel({ state: 'connected', tools: ['a'] })).toBe('Up · 1 tool')
    expect(stateLabel({ state: 'needs-auth', tools: [] })).toBe('Needs sign-in')
    expect(stateLabel({ state: 'failed', tools: [] })).toBe('Down')
    expect(stateLabel({ state: 'disabled', tools: [] })).toBe('Disabled')
  })

  it('never paints a server that is not connected green', () => {
    for (const [state, dot] of Object.entries(STATE_DOT)) {
      if (state !== 'connected') expect(dot).not.toBe('bg-success')
    }
  })
})
