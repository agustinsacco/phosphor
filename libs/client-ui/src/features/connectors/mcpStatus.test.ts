import { describe, expect, it } from 'vitest'
import { STATE_DOT, connectorStatus, stateLabel } from './mcpStatus'

describe('stateLabel', () => {
  it('counts tools only for a server that answered', () => {
    expect(stateLabel('connected', 2)).toBe('Up · 2 tools')
    expect(stateLabel('connected', 1)).toBe('Up · 1 tool')
    expect(stateLabel('needs-auth')).toBe('Needs sign-in')
    expect(stateLabel('failed')).toBe('Down')
    expect(stateLabel('disabled')).toBe('Disabled')
  })

  it('never paints a server that is not connected green', () => {
    for (const [state, dot] of Object.entries(STATE_DOT)) {
      if (state !== 'connected') expect(dot).not.toBe('bg-success')
    }
  })
})

describe('connectorStatus', () => {
  it('keeps the last state while a check runs, and never calls a failed check Down', () => {
    expect(connectorStatus(false, { state: 'connected' }).label).toBe('Disabled')
    expect(connectorStatus(true, { state: 'connected', tools: 3, checking: true }).label).toBe(
      'Up · 3 tools · checking…',
    )
    expect(connectorStatus(true, { state: 'failed', failed: true }).label).toBe('Check failed')
    expect(connectorStatus(true, { checking: true }).label).toBe('Checking…')
    expect(connectorStatus(true, {}).label).toBe('Not checked')
  })
})
