import { expect, it } from 'vitest'
import { prefixGroups } from './groups'
import type { FoldedJob } from './fold'
import type { StageEntity } from '../stage-types'
import { FakeBrainStore } from '../__fixtures__/fake-store'
const entity = (ref: string, label: string): StageEntity => ({
  ref,
  label,
  kind: 'component',
  description: '',
  aliases: [],
  keys: [],
})
it('groups at least three prefix siblings only when no parent is supported', () => {
  const entities = ['Harbor CS', 'Harbor Ledger', 'Harbor Docs'].map((label, i) => ({
    ...entity(`n${i}`, label),
    decision: 'new' as const,
    entityId: null,
    candidates: [],
    reason: '',
    auto: true,
  }))
  const job: FoldedJob = { entities, claims: [], parents: [], evidence: [], outcomes: [] }
  expect(prefixGroups(job, entities, new FakeBrainStore())[0]!.members).toEqual(['n0', 'n1', 'n2'])
  job.parents = [{ entity: 'n0', status: 'stated', claim: 'c1' }]
  expect(prefixGroups(job, entities, new FakeBrainStore())).toEqual([])
})
it('reuses a unique allowed prefix parent, leaves duplicates unresolved, and prefers a job ref', () => {
  const siblings = ['Harbor CS', 'Harbor Ledger', 'Harbor Docs'].map((label, i) => ({
    ...entity(`n${i + 1}`, label),
    decision: 'new' as const,
    entityId: null,
    candidates: [],
    reason: '',
    auto: true,
  }))
  const job: FoldedJob = {
      entities: siblings,
      claims: [],
      parents: [],
      evidence: [],
      outcomes: [],
    },
    store = new FakeBrainStore()
  store.cards = [
    {
      id: 'harbor-org',
      label: 'Harbor',
      kind: 'organization',
      description: '',
      aliases: [],
      neighbours: [],
      memories: 3,
    },
  ]
  store.matches = [[{ entityId: 'harbor-org', channel: 'name', score: 1 }]]
  expect(prefixGroups(job, siblings, store)[0]!.parent.entityId).toBe('harbor-org')
  store.cards.push({ ...store.cards[0]!, id: 'harbor-project', kind: 'project' })
  store.matches[0]!.push({ entityId: 'harbor-project', channel: 'name', score: 1 })
  expect(prefixGroups(job, siblings, store)[0]!.parent.entityId).toBeNull()
  const parent = { ...siblings[0]!, ref: 'new-parent', label: 'Harbor', kind: 'project' as const }
  expect(prefixGroups(job, [...siblings, parent], store)[0]!.parent.entityId).toBe('new-parent')
})
