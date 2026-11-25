import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@phosphor/shared/rpc'
import { createTranscriptCache } from './cache'

const preview = {
  messages: [{ role: 'user', content: 'hello' }] satisfies AgentMessage[],
  composer: {},
}

describe('transcript stamp cache', () => {
  it('returns only the matching lane and stamp without copying messages', () => {
    const cache = createTranscriptCache()
    expect(cache.get('lane', 'stamp')).toBeUndefined()
    cache.set('lane', 'stamp', preview)
    expect(cache.get('lane', 'stamp')).toBe(preview)
    expect(cache.get('other', 'stamp')).toBeUndefined()
    expect(cache.get('lane', 'changed')).toBeUndefined()
  })

  it('replaces a stamp and explicitly invalidates a lane', () => {
    const cache = createTranscriptCache()
    cache.set('lane', 'old', preview)
    cache.set('lane', 'new', { messages: [], composer: {} })
    expect(cache.get('lane', 'old')).toBeUndefined()
    expect(cache.get('lane', 'new')).toEqual({ messages: [], composer: {} })
    cache.delete('lane')
    expect(cache.get('lane', 'new')).toBeUndefined()
    cache.delete('missing')
  })

  it('keeps four entries and evicts the oldest successful use', () => {
    const cache = createTranscriptCache()
    for (let id = 0; id < 4; id++) cache.set(String(id), 'stamp', preview)
    cache.set('0', 'stamp', preview)
    cache.set('4', 'stamp', preview)
    expect(cache.get('1', 'stamp')).toBeUndefined()
    for (const id of ['0', '2', '3', '4']) expect(cache.get(id, 'stamp')).toBe(preview)
  })

  it('does not refresh recency on a lookup without a successful set', () => {
    const cache = createTranscriptCache()
    for (let id = 0; id < 4; id++) cache.set(String(id), 'stamp', preview)
    expect(cache.get('0', 'stamp')).toBe(preview)
    expect(cache.get('0', 'stale')).toBeUndefined()
    cache.set('4', 'stamp', preview)
    expect(cache.get('0', 'stamp')).toBeUndefined()
  })

  it('does not evict another lane when replacing or deleting an entry', () => {
    const cache = createTranscriptCache()
    for (let id = 0; id < 4; id++) cache.set(String(id), 'stamp', preview)
    cache.set('0', 'new', preview)
    cache.delete('2')
    cache.set('4', 'stamp', preview)
    expect(cache.get('0', 'new')).toBe(preview)
    for (const id of ['1', '3', '4']) expect(cache.get(id, 'stamp')).toBe(preview)
  })
})
