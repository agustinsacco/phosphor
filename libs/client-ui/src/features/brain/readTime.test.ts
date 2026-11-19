import { expect, it } from 'vitest'
import { mockCallTrace } from './mockExtractionView'
import { readTime } from './readTime'

const traced = (totalMs: number) => ({ trace: mockCallTrace(totalMs) })

it('adds up calls made one after another', () => {
  expect(readTime([traced(30_000), traced(45_000), traced(5_000)])).toBe(80_000)
})

it('has no duration when any call has no trace', () => {
  expect(readTime([traced(30_000), { trace: null }])).toBeNull()
})

it('has no duration without calls', () => {
  expect(readTime([])).toBeNull()
})

it('counts the questions a refresh asked again, not the days between', () => {
  const read = [traced(120_000), traced(20_000)]
  const refresh = [traced(15_000)]
  expect(readTime([...read, ...refresh])).toBe(155_000)
})
