import { expect, it } from 'vitest'
import type { MemoryCard, ProposalMemory } from '@phosphor/memory-engine/types'
import { FakeBrainStore, FakeBrainSearch } from '../__fixtures__/fake-store'
import { trackAsk } from '../__fixtures__/stage-ask'
import { reconcile } from './reconcile'
import type { FoldedJob } from './fold'

const memory = (summary: string): ProposalMemory => ({
  summary,
  type: 'preference',
  kind: 'reported',
  entities: ['rina'],
  links: [],
  citations: [{ evidence: 0, quote: summary }],
  branch: false,
  validFrom: null,
  validTo: null,
  action: 'add',
  target: null,
  reason: '',
})
const weekly: MemoryCard = {
  id: 'weekly',
  jobId: null,
  summary: 'Rina Okafor wants weekly status updates.',
  type: 'preference',
  kind: 'reported',
  state: 'active',
  entityIds: ['rina'],
  links: [],
  scope: '/harbor',
  branch: null,
  validFrom: null,
  validTo: null,
  recordedAt: 0,
  lanes: 1,
  saidBy: 'you',
  importance: 1,
  observedAt: 0,
  origin: null,
}
const job = (summary: string): FoldedJob => ({
  entities: [],
  claims: [{ ref: 'w1:c3', memory: memory(summary) }],
  parents: [],
  evidence: [],
  outcomes: [],
})
function stored() {
  const store = new FakeBrainStore()
  store.oldMemories = [weekly]
  store.matchesMemory = [['weekly']]
  return store
}
const answer = (action: string, target: string | null) =>
  JSON.stringify({ decisions: [{ ref: 'w1:c3', action, target, reason: 'Model reason' }] })
const replacing = 'Rina Okafor wants daily status updates, superseding the weekly cadence.'

it('asks once more when a claim says it supersedes something but the answer adds it', async () => {
  const answers = [answer('add', null), answer('supersede', 'M1')]
  const ask = trackAsk(async (_s, _p, _prompt, validate) => validate(answers.shift()!))
  const j = job(replacing)
  await reconcile(j, [], stored(), new FakeBrainSearch(), [new Float32Array([1])], ask.ask)
  expect(ask.spy).toHaveBeenCalledTimes(2)
  const second = ask.spy.mock.calls[1]![2] as string
  const rows = JSON.parse(second.slice(second.indexOf('\n') + 1)) as { correction?: string }[]
  expect(rows[0]!.correction).toContain('its own sentence says it supersedes')
  expect(j.claims[0]!.memory).toMatchObject({ action: 'supersede', target: 'weekly' })
  expect(j.outcomes).toEqual([])
})

it('keeps a claim the second answer still adds, with a noted outcome of its own', async () => {
  const ask = trackAsk(async (_s, _p, _prompt, validate) => validate(answer('add', null)))
  const j = job('Rina Okafor no longer wants status updates by email.')
  await reconcile(j, [], stored(), new FakeBrainSearch(), [new Float32Array([1])], ask.ask)
  expect(ask.spy).toHaveBeenCalledTimes(2)
  expect(j.claims[0]!.memory).toMatchObject({ action: 'add', target: null })
  expect(j.outcomes).toEqual([
    {
      candidate: 'w1:c3:supersede',
      summary: 'Rina Okafor no longer wants status updates by email.',
      status: 'noted',
      reason:
        'Its sentence says it replaces something, but asked twice, reconcile found nothing it replaces.',
    },
  ])
})

it('asks only once when the sentence claims no change, or the answer already targets a memory', async () => {
  const plain = trackAsk(async (_s, _p, _prompt, validate) => validate(answer('add', null)))
  await reconcile(
    job('Rina Okafor wants status updates in bullet points.'),
    [],
    stored(),
    new FakeBrainSearch(),
    [new Float32Array([1])],
    plain.ask,
  )
  expect(plain.spy).toHaveBeenCalledOnce()
  const targeted = trackAsk(async (_s, _p, _prompt, validate) => validate(answer('conflict', 'M1')))
  await reconcile(
    job(replacing),
    [],
    stored(),
    new FakeBrainSearch(),
    [new Float32Array([1])],
    targeted.ask,
  )
  expect(targeted.spy).toHaveBeenCalledOnce()
})
