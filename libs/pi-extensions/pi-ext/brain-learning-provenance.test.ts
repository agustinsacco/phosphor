import { describe, expect, it } from 'vitest'
import { learningProvenance } from './brain-learning-provenance'

const message = (id: string, role: string) => ({ id, type: 'message', message: { role } })
describe('learning provenance', () => {
  it('inherits inputs for generated text without manufacturing a summary root', () => {
    const branch = [
      message('u', 'user'),
      message('t', 'toolResult'),
      message('a', 'assistant'),
      { id: 'c', type: 'compaction' },
      message('later', 'user'),
    ]
    const roots = learningProvenance(branch, new Set(['u', 't', 'a', 'c']))
    expect([...roots]).toEqual([
      ['u', ['u']],
      ['t', ['t']],
      ['a', ['u', 't']],
      ['c', ['u', 't']],
    ])
  })
  it('does not assign proof to unqualified branch/custom summaries', () => {
    const roots = learningProvenance(
      [
        message('u', 'user'),
        { id: 'b', type: 'branch_summary' },
        { id: 'c', type: 'custom_message' },
      ],
      new Set(['b', 'c']),
    )
    expect(roots.size).toBe(0)
  })
  it('bounds derived provenance before creating repeated dependency arrays', () => {
    const branch = [
      ...Array.from({ length: 1001 }, (_, i) => message(`u${i}`, 'user')),
      message('a', 'assistant'),
    ]
    expect(() => learningProvenance(branch, new Set(['a']))).toThrow(/1000 roots/)
    expect(learningProvenance(branch, new Set(['u1000'])).get('u1000')).toEqual(['u1000'])
  })
})
