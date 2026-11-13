import { describe, expect, it } from 'vitest'
import { prRef, prSummary } from './__fixtures__/pullRequests'
import { lanePr } from './__fixtures__/lanePr'
import { lanePrUrl, prBeadLine, prBeads, prMenuLabel } from './prBeads'
import { prVerdict } from './prVerdict'

const read = lanePr(prSummary())
const unread = { ...read, pr: undefined, verdict: prVerdict(undefined) }

describe('prBeadLine', () => {
  it('names the PR, its verdict word and why', () => {
    expect(prBeadLine(read)).toBe('#57 Failing · Rocky review failed (not required)')
  })

  it('does not repeat a headline that only restates the word', () => {
    expect(prBeadLine(lanePr(prSummary({ state: 'MERGED' })))).toBe('#57 Merged')
  })

  it('says when what it shows may be old, and when it was never read', () => {
    expect(prBeadLine({ ...read, stale: true })).toMatch(/\(may be out of date\)$/)
    expect(prBeadLine(unread)).toBe('#57 Loading')
    expect(prBeadLine({ ...unread, stale: true })).toBe('#57 Status unavailable')
  })
})

describe('prBeads', () => {
  it('shows three, counts the rest and lists them all', () => {
    const prs = [1, 2, 3, 4].map((n) => lanePr(prSummary({ ref: prRef(n), number: n })))
    const view = prBeads(prs)
    expect(view.shown.map((p) => p.number)).toEqual([1, 2, 3])
    expect(view.more).toBe(1)
    expect(view.lines).toHaveLength(4)
    expect(view.tone).toBe('failing')
  })
})

describe('prMenuLabel', () => {
  it('reads like the bead’s tooltip, shorter', () => {
    expect(prMenuLabel(read)).toBe('#57 · Failing')
  })
})

describe('lanePrUrl', () => {
  it('prefers GitHub’s URL, then builds one from the ref, else has none', () => {
    expect(lanePrUrl(read)).toBe('https://github.com/agustinsacco/Phosphor/pull/57')
    expect(lanePrUrl({ ...unread, ref: prRef(9) })).toBe(
      'https://github.com/agustinsacco/Phosphor/pull/9',
    )
    expect(lanePrUrl({ ...unread, ref: undefined })).toBeUndefined()
  })
})
