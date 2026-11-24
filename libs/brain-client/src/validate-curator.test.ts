import { describe, expect, it } from 'vitest'
import { BRAIN_CURATOR_METHODS, BRAIN_LANE_METHODS } from '@phosphor/shared/brain-agent'
import { validateBrainRequest } from './validate'
import {
  isBrainCuratorMethod,
  isCuratorRequestError,
  validateCuratorRequest,
} from './validate-curator'

const reason = 'Both records name the same Slack user.'
const valid = {
  waiting: { limit: 60 },
  suggestion: { suggestionId: 'sugg-rina' },
  entity: { entityId: 'rina' },
  memory: { memoryId: 'ownership' },
  relate: {
    subjectId: 'rina',
    objectId: 'harbor',
    predicate: 'owns',
    label: 'owns',
    memoryIds: ['ownership'],
    reason,
  },
  resolve: { suggestionId: 'sugg-rina', action: { kind: 'merge', survivorId: 'rina' }, reason },
  edit: {
    edit: { kind: 'describe', entityId: 'rina', description: 'Harbor billing lead' },
    reason,
  },
  correct: {
    memoryId: 'ownership',
    summary: 'Tom Lee owns Harbor billing.',
    source: 'Linear KES-12',
    quote: 'Tom Lee takes over Harbor billing from November.',
    reason,
  },
  erase: { memoryId: 'ownership', reason },
  undo: { operationId: 'op-1', reason },
} as const

describe('validateCuratorRequest', () => {
  it('covers every curator method but search, which keeps its own rules', () => {
    expect(BRAIN_CURATOR_METHODS.filter((m) => !isBrainCuratorMethod(m))).toEqual(['search'])
    expect(BRAIN_LANE_METHODS.filter(isBrainCuratorMethod)).toEqual([])
    for (const [method, input] of Object.entries(valid))
      expect(validateBrainRequest(method as keyof typeof valid, input)).toEqual(input)
  })

  it('trims reasons and refuses empty, oversize or NUL reasons', () => {
    expect(validateCuratorRequest('erase', { memoryId: 'm', reason: `  ${reason}  ` })).toEqual({
      memoryId: 'm',
      reason,
    })
    for (const bad of ['', '   ', 'x'.repeat(301), 'a\0b', 7, undefined])
      expect(() => validateCuratorRequest('erase', { memoryId: 'm', reason: bad })).toThrow(
        /reason/,
      )
    expect(
      validateCuratorRequest('undo', { operationId: 'op', reason: 'x'.repeat(300) }).reason,
    ).toHaveLength(300)
  })

  it('refuses unknown or missing keys, padded and oversize ids, and non-objects', () => {
    const cases: [keyof typeof valid, unknown][] = [
      ['entity', { entityId: 'job', extra: 1 }],
      ['entity', {}],
      ['entity', { entityId: ' job' }],
      ['entity', { entityId: 'j'.repeat(201) }],
      ['entity', { entityId: '' }],
      ['memory', null],
      ['waiting', []],
      ['waiting', { limit: 0 }],
      ['waiting', { limit: 201 }],
      ['waiting', { limit: 1.5 }],
    ]
    for (const [method, input] of cases) {
      let thrown: unknown
      try {
        validateCuratorRequest(method, input)
      } catch (error) {
        thrown = error
      }
      expect(isCuratorRequestError(thrown), JSON.stringify([method, input])).toBe(true)
    }
    expect(validateCuratorRequest('waiting', {})).toEqual({})
  })

  it('keeps erasing out of resolve and checks every action shape', () => {
    expect(() =>
      validateCuratorRequest('resolve', { ...valid.resolve, action: { kind: 'forget' } }),
    ).toThrow('Erase a memory with erase')
    for (const action of [
      { kind: 'fold', survivorId: 'm1' },
      { kind: 'replace', newerId: 'm2' },
      { kind: 'dispute' },
      { kind: 'keep' },
      { kind: 'unname', entityId: 'rina', name: 'Rina' },
    ])
      expect(validateCuratorRequest('resolve', { ...valid.resolve, action }).action).toEqual(action)
    for (const action of [{ kind: 'merge' }, { kind: 'keep', extra: 1 }, { kind: 'shout' }, null])
      expect(() => validateCuratorRequest('resolve', { ...valid.resolve, action })).toThrow(
        /Brain action/,
      )
  })

  it('checks each edit kind with its own bounds', () => {
    const ok = [
      { kind: 'merge', sourceId: 'rina-2', targetId: 'rina' },
      {
        kind: 'split',
        entityId: 'rina',
        memoryIds: ['m1', 'm2'],
        label: 'Rina Voss',
        entityKind: 'person',
      },
      { kind: 'removeName', entityId: 'rina', name: 'Rina' },
    ]
    for (const edit of ok)
      expect(validateCuratorRequest('edit', { edit, reason }).edit).toEqual(edit)
    const bad = [
      { kind: 'describe', entityId: 'rina', description: 'x'.repeat(161) },
      { kind: 'split', entityId: 'rina', memoryIds: [], label: 'Rina Voss', entityKind: 'person' },
      {
        kind: 'split',
        entityId: 'rina',
        memoryIds: ['m1', 'm1'],
        label: 'R',
        entityKind: 'person',
      },
      { kind: 'split', entityId: 'rina', memoryIds: ['m1'], label: 'R', entityKind: 'robot' },
      {
        kind: 'split',
        entityId: 'rina',
        memoryIds: ['m1'],
        label: 'x'.repeat(81),
        entityKind: 'person',
      },
      { kind: 'merge', sourceId: 'rina-2' },
      { kind: 'rename', entityId: 'rina' },
    ]
    for (const edit of bad)
      expect(() => validateCuratorRequest('edit', { edit, reason }), JSON.stringify(edit)).toThrow()
  })

  it('bounds corrections', () => {
    for (const [field, max] of [
      ['summary', 1200],
      ['source', 120],
      ['quote', 600],
    ] as const) {
      expect(() =>
        validateCuratorRequest('correct', { ...valid.correct, [field]: 'x'.repeat(max + 1) }),
      ).toThrow(field)
      expect(() => validateCuratorRequest('correct', { ...valid.correct, [field]: ' ' })).toThrow(
        field,
      )
    }
  })
})
