import { expect, it } from 'vitest'
import { mockBrainProposal } from './mockBrainData'

it('keeps the original confirmation claim and its identity refs in the browser review contract', () => {
  const proposal = mockBrainProposal()
  expect(proposal.confirmations[0]).toMatchObject({
    id: 'memory-2',
    claim: {
      summary: 'Tom Lee supports Harbor Ledger.',
      type: 'fact',
      entities: ['tom', 'ledger'],
      links: [
        {
          subject: 'tom',
          predicate: 'works_on',
          object: 'ledger',
          quote: 'Tom Lee supports Harbor Ledger.',
        },
      ],
      quotes: [expect.objectContaining({ quote: 'Tom Lee supports Harbor Ledger.' })],
    },
  })
})
