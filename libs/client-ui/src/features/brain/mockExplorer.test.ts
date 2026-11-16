import { expect, it } from 'vitest'
import { MockExplorer } from './mockExplorer'
import { mockBrainJob } from './mockBrainData'

it('omits orphaned and non-done reads, excludes superseded memories and sorts within each job', () => {
  const explorer = new MockExplorer()
  const original = explorer.details[0]!
  explorer.details = [
    ['orphan', 'missing', 'active', 900],
    ['pending', 'review', 'active', 800],
    ['old', 'done', 'superseded', 700],
    ['active', 'done', 'active', 100],
    ['disputed', 'done', 'disputed', 200],
    ['tie', 'done', 'active', 200],
  ].map(([id, jobId, state, recordedAt]) => ({
    ...original,
    memory: { ...original.memory, id, jobId, state, recordedAt },
  })) as typeof explorer.details
  const jobs = [mockBrainJob({ id: 'review' }), mockBrainJob({ id: 'done', state: 'done' })]
  expect(explorer.recent(50, jobs).items.map((m) => m.id)).toEqual(['tie', 'disputed', 'active'])
  expect(explorer.recent(1, jobs).items.map((m) => m.learnedAt)).toEqual([200])
})
