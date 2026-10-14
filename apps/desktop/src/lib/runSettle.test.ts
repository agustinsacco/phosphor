import { describe, expect, it } from 'vitest'
import { createSettleTracker } from './runSettle'

describe('createSettleTracker', () => {
  it('reports a run that settled on its own, once', () => {
    const tracker = createSettleTracker()
    expect(tracker.finished('a', { type: 'agent_start' })).toBe(false)
    expect(tracker.finished('a', { type: 'agent_end', messages: [] })).toBe(false)
    expect(tracker.finished('a', { type: 'agent_settled', aborted: false })).toBe(true)
    expect(tracker.finished('a', { type: 'agent_settled', aborted: false })).toBe(false)
  })

  it('stays quiet for an aborted run and a settle without a run', () => {
    const tracker = createSettleTracker()
    expect(tracker.finished('a', { type: 'agent_settled', aborted: false })).toBe(false)
    tracker.finished('a', { type: 'agent_start' })
    expect(tracker.finished('a', { type: 'agent_settled', aborted: true })).toBe(false)
  })

  it('keeps sessions apart and forgets a closed one', () => {
    const tracker = createSettleTracker()
    tracker.finished('a', { type: 'agent_start' })
    tracker.finished('b', { type: 'agent_start' })
    tracker.forget('a')
    expect(tracker.finished('a', { type: 'agent_settled', aborted: false })).toBe(false)
    expect(tracker.finished('b', { type: 'agent_settled', aborted: false })).toBe(true)
  })
})
