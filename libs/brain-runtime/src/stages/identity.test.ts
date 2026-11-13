import { trackAsk } from '../__fixtures__/stage-ask'
import { expect, it } from 'vitest'
import { FakeBrainStore, FakeBrainSearch } from '../__fixtures__/fake-store'
import { resolveIdentities } from './identity'
import { foldParts, type FoldedJob } from './fold'
import type { StageAsk, StageEntity } from '../stage-types'
import { makeWindow } from '../windows'

const entity = (
  ref: string,
  label: string,
  kind: StageEntity['kind'] = 'project',
): StageEntity => ({ ref, label, kind, aliases: [], description: '', keys: [] })
const job = (entities: StageEntity[]): FoldedJob => ({
  entities,
  claims: [],
  evidence: [],
  parents: [],
  outcomes: [],
})
const storeCard = (id: string, label: string, kind: StageEntity['kind'] = 'person') => ({
  id,
  label,
  kind,
  aliases: [],
  description: '',
  neighbours: [],
  memories: 2,
})
function fakeAsk(action: 'reuse' | 'uncertain' | 'new'): StageAsk {
  return async (_stage, _part, prompt, validate) => {
    const source = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as {
      entity: StageEntity
      candidates: { handle: string }[]
    }[]
    return validate(
      JSON.stringify({
        decisions: source.map((row, i) => ({
          ref: row.entity.ref,
          action: i === 0 ? action : 'new',
          candidate: i === 0 && action === 'reuse' ? row.candidates[0]!.handle : null,
          reason: 'Fake evidence decision',
        })),
      }),
    )
  }
}
it('reuses a unique key deterministically, including across kinds', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch(),
    j = job([entity('n1', 'Kestrel', 'team')])
  store.cards = [storeCard('existing', 'Kestrel', 'organization')]
  store.matches = [[{ entityId: 'existing', channel: 'key', score: 1 }]]
  const ask = trackAsk()
  const result = await resolveIdentities(j, store, search, [new Float32Array([1])], ask.ask)
  expect(result.entities[0]).toMatchObject({ decision: 'reuse', entityId: 'existing', auto: true })
  expect(ask.spy).not.toHaveBeenCalled()
})
it('a stored Tom Lee never reuses a new-lane Tom Lee on name alone', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch(),
    j = job([entity('n1', 'Tom Lee', 'person')])
  store.cards = [storeCard('old-tom', 'Tom Lee')]
  store.matches = [[{ entityId: 'old-tom', channel: 'name', score: 1 }]]
  const ask = trackAsk(fakeAsk('new'))
  const result = await resolveIdentities(j, store, search, [new Float32Array([1])], ask.ask)
  expect(ask.spy).toHaveBeenCalledOnce()
  expect(result.entities[0]).toMatchObject({ decision: 'new', entityId: null, auto: false })
})
it('Call 2 may reuse across kinds, and uncertainty reaches review for stored candidates', async () => {
  for (const action of ['reuse', 'uncertain'] as const) {
    const store = new FakeBrainStore(),
      search = new FakeBrainSearch(),
      j = job([entity('n1', 'Harbor', 'component')])
    store.cards = [storeCard('project', 'Harbor', 'project')]
    store.matches = [[{ entityId: 'project', channel: 'name', score: 1 }]]
    const result = await resolveIdentities(
      j,
      store,
      search,
      [new Float32Array([1])],
      fakeAsk(action),
    )
    expect(result.entities[0]!.decision).toBe(action)
    expect(result.entities[0]!.auto).toBe(false)
  }
})
it.each(['reuse', 'uncertain'] as const)(
  'first lane after wipe offers job candidates and handles %s',
  async (action) => {
    const j = job([entity('w1:n1', 'CS workflow'), entity('w1:n2', 'Harbor CS workflow')])
    const result = await resolveIdentities(
      j,
      new FakeBrainStore(),
      new FakeBrainSearch(),
      [new Float32Array([1]), new Float32Array([1])],
      fakeAsk(action),
    )
    expect(result.entities).toHaveLength(action === 'reuse' ? 1 : 2)
    expect(result.entities.every((e) => e.entityId === null && e.candidates.length === 0)).toBe(
      true,
    )
    expect(j.outcomes.filter((o) => o.status === 'folded')).toHaveLength(action === 'reuse' ? 1 : 0)
  },
)
it('folds repeated full names across windows but not a first name alone or contradictory keys', () => {
  const entities = [
    entity('w1:n1', 'Tom Lee', 'person'),
    entity('w3:n1', 'Tom Lee', 'person'),
    { ...entity('w2:n1', 'Tom', 'person'), aliases: ['Tom Lee'] },
    { ...entity('w4:n1', 'Tom Lee', 'person'), keys: [{ namespace: 'staff', value: 'other' }] },
  ]
  entities[0]!.keys = [{ namespace: 'staff', value: 'one' }]
  const parts = entities.map((e, i) => ({
    key: `w${i}`,
    window: makeWindow([]),
    truncated: false,
    extraction: { entities: [e], claims: [], parents: [] },
  }))
  const folded = foldParts(parts, 'lane')
  expect(folded.entities.map((e) => e.label)).toEqual(['Tom Lee', 'Tom Lee'])
  const separate = foldParts(
    [
      {
        key: 'w1',
        window: makeWindow([]),
        truncated: false,
        extraction: {
          entities: [entity('n1', 'Tom', 'person'), entity('n2', 'Tom Lee', 'person')],
          claims: [],
          parents: [],
        },
      },
    ],
    'lane',
  )
  expect(separate.entities).toHaveLength(2)
})
