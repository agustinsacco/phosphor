import { describe, expect, it } from 'vitest'
import { laneHaystack, laneMatches, laneQueryTerms, type LaneSearchFields } from './laneSearch'

const lane: LaneSearchFields = {
  title: 'Fix And Rebase PR 130',
  branch: 'phosphor/fix-and-rebase-pr-130',
  pr: { number: 412, title: 'Adjust tool group spacing' },
}

function finds(query: string, fields: LaneSearchFields = lane): boolean {
  return laneMatches(laneHaystack(fields), laneQueryTerms(query))
}

describe('laneQueryTerms', () => {
  it('drops punctuation and splits on any separator run', () => {
    expect(laneQueryTerms('  #412 / rebase-pr  ')).toEqual(['412', 'rebase', 'pr'])
  })

  it('is empty for a query with nothing to match', () => {
    expect(laneQueryTerms('')).toEqual([])
    expect(laneQueryTerms('   ')).toEqual([])
    expect(laneQueryTerms('#')).toEqual([])
  })
})

describe('laneMatches', () => {
  it('matches the title, case-insensitively', () => {
    expect(finds('rebase')).toBe(true)
    expect(finds('FIX AND')).toBe(true)
  })

  it('matches the branch across its separators', () => {
    expect(finds('Phosphor fix')).toBe(true)
    expect(finds('fix-and-rebase')).toBe(true)
  })

  it('matches a PR by number, with or without the hash', () => {
    expect(finds('#412')).toBe(true)
    expect(finds('412')).toBe(true)
  })

  it('matches a PR by title', () => {
    expect(finds('tool group')).toBe(true)
  })

  it('ANDs terms and ignores their order', () => {
    expect(finds('130 rebase')).toBe(true)
    expect(finds('rebase 130')).toBe(true)
    expect(finds('rebase nothing')).toBe(false)
  })

  it('matches every lane when the query has no terms', () => {
    expect(finds('')).toBe(true)
  })

  it('does not match on a subsequence', () => {
    // 'fxr' is a subsequence of "fix and rebase" but not a substring: a
    // subsequence matcher would keep this lane and read as a dead filter.
    expect(finds('fxr')).toBe(false)
  })

  it('searches lanes with no branch and no PR', () => {
    const bare: LaneSearchFields = { title: 'Untitled session' }
    expect(finds('untitled', bare)).toBe(true)
    expect(finds('412', bare)).toBe(false)
  })
})
