import { expect, it } from 'vitest'
import { mockBrainData, MOCK_SAID_AT } from '../mockBrainData'
import { memoryWords } from './memoryWords'

it('says a memory’s metadata in plain words', () => {
  const { details } = mockBrainData()
  const memory = (index: number) => details[index]!.memory
  expect(memoryWords(memory(1), MOCK_SAID_AT)).toBe(
    'decision · still true · you said it · told · 2 lanes · important',
  )
  expect(memoryWords(memory(10), MOCK_SAID_AT)).toBe(
    'fact · still true · an agent said it · guessed · 1 lane',
  )
  expect(memoryWords(memory(14), MOCK_SAID_AT)).toContain('replaced')
  expect(memoryWords(memory(17), Date.UTC(2027, 0, 2))).toContain('ended 2026-12-31')
})
