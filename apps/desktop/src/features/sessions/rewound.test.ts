import { describe, expect, it } from 'vitest'
import {
  latestRewoundVersion,
  presentSessionFiles,
  withoutRewindOf,
  withoutSession,
  withRewind,
} from './rewound'

describe('rewind record', () => {
  it('records by file name and ignores a rewind that stayed on one file', () => {
    const record = withRewind({}, '/dir/a.jsonl', '/dir/b.jsonl')
    expect(record).toEqual({ 'a.jsonl': 'b.jsonl' })
    expect(withRewind(record, '/dir/b.jsonl', '/other/b.jsonl')).toBe(record)
  })

  it('repairs a chain when a middle file is deleted', () => {
    const record = { 'a.jsonl': 'b.jsonl', 'b.jsonl': 'c.jsonl' }
    expect(withoutSession(record, '/dir/b.jsonl')).toEqual({ 'a.jsonl': 'c.jsonl' })
  })

  it('drops the record when the successor is deleted, so the old file shows again', () => {
    expect(withoutSession({ 'a.jsonl': 'b.jsonl' }, '/dir/b.jsonl')).toEqual({})
    expect(withoutSession({ 'a.jsonl': 'b.jsonl' }, '/dir/a.jsonl')).toEqual({})
    const untouched = { 'a.jsonl': 'b.jsonl' }
    expect(withoutSession(untouched, '/dir/z.jsonl')).toBe(untouched)
  })

  it('forgets only the link out of a version someone carried on in', () => {
    const record = { 'a.jsonl': 'b.jsonl', 'b.jsonl': 'c.jsonl' }
    expect(withoutRewindOf(record, '/dir/b.jsonl')).toEqual({ 'a.jsonl': 'b.jsonl' })
    expect(withoutRewindOf(record, '/dir/c.jsonl')).toBe(record)
  })

  it('counts live files that are not on disk yet', () => {
    const present = presentSessionFiles({ '/w': [{ path: '/s/a.jsonl' }] }, [
      '/s/b.jsonl',
      undefined,
    ])
    expect([...present].sort()).toEqual(['a.jsonl', 'b.jsonl'])
  })

  it('answers the last version on disk', () => {
    const record = { 'a.jsonl': 'b.jsonl', 'b.jsonl': 'c.jsonl' }
    expect(latestRewoundVersion(record, '/x/a.jsonl', new Set(['b.jsonl', 'c.jsonl']))).toBe(
      'c.jsonl',
    )
    expect(latestRewoundVersion(record, '/x/a.jsonl', new Set(['b.jsonl']))).toBe('b.jsonl')
    expect(latestRewoundVersion(record, '/x/a.jsonl', new Set())).toBeNull()
  })
})
