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
  readReview: { jobId: 'job-ledger' },
  suggestion: { suggestionId: 'sugg-rina' },
  entity: { entityId: 'rina' },
  memory: { memoryId: 'ownership' },
  decideRead: { jobId: 'job-ledger', revision: 41, approve: false, reason },
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
      ['readReview', { jobId: 'job', extra: 1 }],
      ['readReview', {}],
      ['readReview', { jobId: ' job' }],
      ['readReview', { jobId: 'j'.repeat(201) }],
      ['entity', { entityId: '' }],
      ['memory', null],
      ['waiting', []],
      ['waiting', { limit: 0 }],
      ['waiting', { limit: 201 }],
      ['waiting', { limit: 1.5 }],
      ['decideRead', { ...valid.decideRead, revision: -1 }],
      ['decideRead', { ...valid.decideRead, revision: '41' }],
      ['decideRead', { jobId: 'job-ledger', revision: 41, reason }],
      ['decideRead', { ...valid.decideRead, approve: 'yes' }],
      ['decideRead', { ...valid.decideRead, decision: null }],
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
    expect(validateCuratorRequest('readReview', { jobId: 'j'.repeat(200) }).jobId).toHaveLength(200)
  })

  it('takes a review offset that is a whole number, 0 or more', () => {
    for (const offset of [0, 3, 10_000])
      expect(validateCuratorRequest('readReview', { jobId: 'job', offset })).toEqual({
        jobId: 'job',
        offset,
      })
    for (const offset of [-1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1])
      expect(() => validateCuratorRequest('readReview', { jobId: 'job', offset })).toThrow(
        'Brain review offset must be a whole number, 0 or more.',
      )
  })

  it("takes brain_decide_read's own choices within its limits", () => {
    const choices = {
      memories: [0, 2],
      identities: [{ ref: 'e1', answer: 'rina' }],
      groups: [1],
      descriptions: ['e1'],
      confirmations: [0],
    }
    expect(
      validateCuratorRequest('decideRead', { ...valid.decideRead, approve: true, ...choices }),
    ).toEqual({ ...valid.decideRead, approve: true, ...choices })
    const bad: [string, unknown, RegExp][] = [
      ['memories', [-1], /memories must be indexes/],
      ['memories', [0.5], /memories must be indexes/],
      [
        'memories',
        Array.from({ length: 401 }, (_, i) => i),
        /memories must be a list of at most 400/,
      ],
      ['groups', 'all', /groups must be a list/],
      ['identities', [{ ref: 'e1' }], /needs answer/],
      ['identities', [{ ref: 'e1', answer: 'new', extra: 1 }], /unknown field: extra/],
      ['identities', [{ ref: 'e'.repeat(65), answer: 'new' }], /identity ref needs 1 to 64/],
      ['identities', [{ ref: 'e1', answer: 'r'.repeat(201) }], /identity answer needs 1 to 200/],
      ['descriptions', [''], /description ref needs 1 to 64/],
      ['confirmations', ['0'], /confirmations must be indexes/],
    ]
    for (const [field, value, message] of bad)
      expect(() =>
        validateCuratorRequest('decideRead', {
          ...valid.decideRead,
          approve: true,
          [field]: value,
        }),
      ).toThrow(message)
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
