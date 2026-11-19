import { trackAsk } from '../__fixtures__/stage-ask'
import { expect, it } from 'vitest'
import { FakeBrainStore, FakeBrainSearch } from '../__fixtures__/fake-store'
import { resolveIdentities } from './identity'
import type { FoldedJob } from './fold'
import type { StageAsk, StageEntity } from '../stage-types'

const person = (label: string, aliases: string[] = []): StageEntity => ({
  ref: 'n1',
  label,
  kind: 'person',
  aliases,
  description: '',
  keys: [],
})
const job = (entity: StageEntity): FoldedJob => ({
  entities: [entity],
  claims: [],
  evidence: [],
  parents: [],
  outcomes: [],
})
const card = (
  id: string,
  label: string,
  kind: StageEntity['kind'] = 'person',
  aliases: string[] = [],
) => ({
  id,
  label,
  kind,
  aliases,
  description: '',
  neighbours: [],
  memories: 4,
})
/** The identity call is unsure about every entity. */
const unsure: StageAsk = async (_stage, _part, prompt, validate) => {
  const rows = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as { entity: StageEntity }[]
  return validate(
    JSON.stringify({
      decisions: rows.map((r) => ({
        ref: r.entity.ref,
        action: 'uncertain',
        candidate: null,
        reason: 'Same name, no shared neighbour',
      })),
    }),
  )
}
async function resolve(entity: StageEntity, cards: ReturnType<typeof card>[], ask = unsure) {
  const store = new FakeBrainStore()
  store.cards = cards
  store.matches = [cards.map((c) => ({ entityId: c.id, channel: 'name' as const, score: 1 }))]
  const result = await resolveIdentities(
    job(entity),
    store,
    new FakeBrainSearch(),
    [new Float32Array([1])],
    trackAsk(ask).ask,
  )
  return result.entities[0]!
}

it('requires an answer when an unsure person has exactly the name of one stored person', async () => {
  expect(await resolve(person('Rina Okafor'), [card('rina', 'rina okafor')])).toMatchObject({
    decision: 'uncertain',
    required: true,
  })
  expect(
    await resolve(person('Rina'), [card('rina', 'Rina Okafor', 'person', ['Rina'])]),
  ).toMatchObject({ decision: 'uncertain', required: true })
})

it('does not require an answer for two stored namesakes, another kind, or a loose match', async () => {
  const twins = [card('rina-1', 'Rina Okafor'), card('rina-2', 'Rina Okafor')]
  expect((await resolve(person('Rina Okafor'), twins)).required).toBe(false)
  const team = [card('harbor', 'Harbor', 'team')]
  expect((await resolve({ ...person('Harbor'), kind: 'project' }, team)).required).toBe(false)
  expect((await resolve(person('Rina Okafor'), [card('rina', 'Rina Okafor-Lee')])).required).toBe(
    false,
  )
})

it('does not require an answer when the identity call decided', async () => {
  const decided: StageAsk = async (_stage, _part, prompt, validate) => {
    const rows = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as { entity: StageEntity }[]
    return validate(
      JSON.stringify({
        decisions: rows.map((r) => ({
          ref: r.entity.ref,
          action: 'new',
          candidate: null,
          reason: 'A different Rina',
        })),
      }),
    )
  }
  expect(
    (await resolve(person('Rina Okafor'), [card('rina', 'Rina Okafor')], decided)).required,
  ).toBe(false)
})
