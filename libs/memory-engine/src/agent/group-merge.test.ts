import { expect, it } from 'vitest'
import { fixture, save } from '../test-support'
import { seed } from '../tidy/test-support'

const note = { runId: null, reason: 'The lane names them as one person.' }

it.each([0, 1])(
  'keeps a group question open when Brain Agent merges its member %i, pointing it at the survivor',
  (index) => {
    const { store, db } = fixture()
    seed(db, 1)
    save(store, {
      groups: [
        {
          parent: { label: 'Harbor group', kind: 'organization', entityId: null },
          members: index === 0 ? ['rina', 'tom', 'harbor'] : ['tom', 'rina', 'harbor'],
        },
      ],
    })
    const rina = (
      db.prepare("SELECT id FROM entities WHERE label='Rina Okafor' AND id<>'rina-1'").get() as {
        id: string
      }
    ).id
    store.agentEdit({ kind: 'merge', sourceId: rina, targetId: 'rina-1' }, note)
    expect(store.waitingCounts().groups).toBe(1)
    const row = db
      .prepare("SELECT first_id,second_id,detail FROM tidy_suggestions WHERE kind='group'")
      .get() as { first_id: string; second_id: string; detail: string }
    expect([row.first_id, row.second_id][index]).toBe('rina-1')
    expect(JSON.parse(row.detail).memberIds[index]).toBe('rina-1')
    const question = store.waitingSuggestions(20, 0).items.find((item) => item.kind === 'group')!
    store.resolve(question.suggestionId, { kind: 'group' }, note)
    expect(
      db
        .prepare(
          "SELECT e.id FROM relations r JOIN entities e ON e.n=r.subject WHERE r.predicate='part_of' ORDER BY e.id",
        )
        .all()
        .map((r) => (r as { id: string }).id),
    ).toContain('rina-1')
  },
)

it.each([0, 1])(
  'gives a group question back its member %i when Brain Agent undoes the merge',
  (index) => {
    const { store, db } = fixture()
    seed(db, 1)
    save(store, {
      groups: [
        {
          parent: { label: 'Harbor group', kind: 'organization', entityId: null },
          members: index === 0 ? ['rina', 'tom', 'harbor'] : ['tom', 'rina', 'harbor'],
        },
      ],
    })
    const rina = (
      db.prepare("SELECT id FROM entities WHERE label='Rina Okafor' AND id<>'rina-1'").get() as {
        id: string
      }
    ).id
    const merge = store.agentEdit({ kind: 'merge', sourceId: rina, targetId: 'rina-1' }, note)
    store.agentUndo(merge, note)
    const row = db
      .prepare("SELECT first_id,second_id,detail,state FROM tidy_suggestions WHERE kind='group'")
      .get() as { first_id: string; second_id: string; detail: string; state: string }
    expect(row.state).toBe('open')
    expect([row.first_id, row.second_id][index]).toBe(rina)
    expect(JSON.parse(row.detail).memberIds[index]).toBe(rina)
    const question = store.waitingSuggestions(20, 0).items.find((item) => item.kind === 'group')!
    expect(question.subjects[index]!.id).toBe(rina)
    store.resolve(question.suggestionId, { kind: 'group' }, note)
    const linked = db
      .prepare(
        "SELECT e.id FROM relations r JOIN entities e ON e.n=r.subject WHERE r.predicate='part_of' ORDER BY e.id",
      )
      .all()
      .map((r) => (r as { id: string }).id)
    expect(linked).toContain(rina)
    expect(linked).not.toContain('rina-1')
  },
)
