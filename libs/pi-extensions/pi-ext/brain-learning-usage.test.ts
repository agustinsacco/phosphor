import { expect, it } from 'vitest'
import { learningResponse } from './brain-learning-result'

it('retains only response usage when a stopped response cannot become knowledge', () => {
  for (const stopReason of ['error', 'aborted', 'length', 'toolUse']) {
    let failure: unknown
    try {
      learningResponse({
        role: 'assistant',
        stopReason,
        content: [],
        usage: { input: 21, output: 9, cacheRead: 8, cacheWrite: 0, reasoning: 4 },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toHaveProperty('learningUsage', {
      input: 21,
      output: 9,
      cacheRead: 8,
      cacheWrite: 0,
      reasoning: 4,
    })
  }
})
it('retains available response usage when completed output has a forbidden tool block', () => {
  expect(() =>
    learningResponse({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'toolCall', name: 'bad' }],
      usage: { input: 5, output: 7 },
    }),
  ).toThrowError(
    expect.objectContaining({
      learningUsage: {
        input: 5,
        output: 7,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
      },
    }),
  )
})
