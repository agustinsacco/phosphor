import { expect, it } from 'vitest'
import { parsePrParams, parseRepoPrs } from './host-protocol-github'

const repositoryId = '1234567890abcdef'
it('accepts bounded branch interests without accepting caller filesystem paths', () => {
  expect(parsePrParams({ repositoryId, options: { branches: ['feature'], force: true } })).toBe(
    repositoryId,
  )
  for (const options of [
    { branches: Array.from({ length: 21 }, (_, i) => `b${i}`) },
    { branches: ['same', 'same'] },
    { branches: [''] },
    { branches: ['a'.repeat(4097)] },
    { branches: ['ok'], force: 'yes' },
    { branches: ['ok'], repoPath: '/private' },
  ])
    expect(parsePrParams({ repositoryId, options })).toBeNull()
  expect(parsePrParams({ repositoryId, repoPath: '/private' })).toBeNull()
  expect(parsePrParams({ repositoryId: '/private', options: { branches: ['ok'] } })).toBeNull()
})
it('preserves validated per-branch coverage and bounds both reply maps', () => {
  const coverage = { feature: { state: 'absent', checkedAt: 10, attemptedAt: 12 } }
  expect(parseRepoPrs({ byBranch: {}, complete: false, coverage })).toEqual({
    byBranch: {},
    complete: false,
    coverage,
  })
  for (const row of [
    { state: 'unknown', checkedAt: 10, attemptedAt: 12 },
    { state: 'absent', checkedAt: -1, attemptedAt: 12 },
    { state: 'unavailable', checkedAt: 0, attemptedAt: 12, reason: 'secret' },
  ])
    expect(parseRepoPrs({ byBranch: {}, complete: false, coverage: { feature: row } })).toBeNull()
  const many = Object.fromEntries(
    Array.from({ length: 101 }, (_, i) => [`b${i}`, coverage.feature]),
  )
  expect(parseRepoPrs({ byBranch: {}, complete: false, coverage: many })).toBeNull()
})
