import { expect, it } from 'vitest'
import { waitingBreakdown, waitingCount } from './agentStatus'
import { mockBrainStatus } from './mockBrainData'
it('counts and names every waiting kind, omitting zero kinds', () => {
  const status = mockBrainStatus()
  status.agent.waiting = { reads: 6, entities: 10, repeats: 13, conflicts: 1, flags: 1 }
  expect(waitingCount(status)).toBe(31)
  expect(waitingBreakdown(status.agent.waiting)).toBe(
    '31 waiting: 6 reads, 10 people and things, 13 repeats, 1 disagreement, 1 flag',
  )
  expect(waitingBreakdown({ reads: 1, entities: 0, repeats: 0, conflicts: 0, flags: 0 })).toBe(
    '1 waiting: 1 read',
  )
  expect(waitingCount(null)).toBe(0)
})
