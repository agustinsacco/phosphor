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

it('retains earliest run start through agent_end, settles once and forgets timing', () => {
  let now = 10
  const tracker = createSettleTracker(() => now)
  tracker.settle('lane', { type: 'agent_start' })
  now = 20
  tracker.settle('lane', { type: 'agent_start' })
  tracker.settle('lane', { type: 'agent_end', messages: [] })
  expect(tracker.settle('lane', { type: 'agent_settled', aborted: false })).toEqual({
    finished: true,
    startedAt: 10,
  })
  expect(tracker.settle('lane', { type: 'agent_settled', aborted: false })).toEqual({
    finished: false,
    startedAt: null,
  })
  tracker.settle('lane', { type: 'agent_start' })
  tracker.forget('lane')
  expect(tracker.settle('lane', { type: 'agent_settled', aborted: false })).toEqual({
    finished: false,
    startedAt: null,
  })
  tracker.settle('lane', { type: 'agent_start' })
  expect(tracker.settle('lane', { type: 'agent_settled', aborted: true })).toEqual({
    finished: false,
    startedAt: 20,
  })
})
