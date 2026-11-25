import { expect, it } from 'vitest'
import { waitingBreakdown, waitingCount } from './agentStatus'
import { mockBrainStatus } from './mockBrainData'
it('counts and names every waiting kind, omitting zero kinds', () => {
  const status = mockBrainStatus()
  status.agent.waiting = {
    entities: 10,
    groups: 2,
    unlinked: 6,
    repeats: 13,
    conflicts: 1,
    flags: 1,
  }
  expect(waitingCount(status)).toBe(33)
  expect(waitingBreakdown(status.agent.waiting)).toBe(
    '33 waiting: 10 people and things, 2 groups, 6 unlinked pairs, 13 repeats, 1 disagreement, 1 flag',
  )
  expect(
    waitingBreakdown({ entities: 0, groups: 0, unlinked: 1, repeats: 0, conflicts: 0, flags: 0 }),
  ).toBe('1 waiting: 1 unlinked pair')
  expect(waitingCount(null)).toBe(0)
})
