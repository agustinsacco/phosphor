import { afterEach, describe, expect, it } from 'vitest'
import {
  OWNERSHIP_DETAIL,
  RINA_SUGGESTION,
  RINA_VIEW,
} from '../../../brain-client/src/__fixtures__/curator'
import { HARBOR_RECALL } from '../../../brain-client/src/__fixtures__/recall'
import { curatorFixture } from '../__fixtures__/curator'
import { BRAIN_OFF } from './curator-context'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const signal = new AbortController().signal
async function curatorSetup() {
  const s = await curatorFixture()
  cleanups.push(s.cleanup)
  return s
}

describe('curator reads', () => {
  it('suggestion, entity and memory pass through without lane paths', async () => {
    const s = await curatorSetup()
    const detail = { ...OWNERSHIP_DETAIL, sourcePath: '/lanes/harbor.jsonl' }
    s.store.details.push(detail)
    expect((await s.curator.memory({ memoryId: 'ownership' }, signal)).sourcePath).toBeNull()
    s.store.agentSuggestion = () => ({
      ...RINA_SUGGESTION,
      subjects: [{ type: 'memory', value: detail }],
    })
    const suggestion = await s.curator.suggestion({ suggestionId: 'sugg' }, signal)
    expect(suggestion?.subjects[0]?.value).toMatchObject({ sourcePath: null })
    expect(detail.sourcePath).toBe('/lanes/harbor.jsonl')
    s.store.agentSuggestion = () => null
    expect(await s.curator.suggestion({ suggestionId: 'gone' }, signal)).toBeNull()
    await expect(s.curator.entity({ entityId: 'rina' }, signal)).rejects.toThrow('No entity')
  })

  it('scrubs every lane title it returns, as stored text is scrubbed', async () => {
    const s = await curatorSetup()
    const title = 'Harbor token=harbor-secret-123'
    const lane = (sessionId: string) => ({ sessionId, title })
    const memory = { ...OWNERSHIP_DETAIL.memory, origin: lane('harbor-lane') }
    const detail = {
      ...OWNERSHIP_DETAIL,
      memory,
      history: [memory],
      related: [{ kind: 'conflicts' as const, memory }],
    }
    s.store.details.push(detail)
    s.store.entity = () => ({ ...RINA_VIEW, sources: [{ ...lane('harbor-lane'), memories: 3 }] })
    s.store.agentSuggestion = () => ({
      ...RINA_SUGGESTION,
      suggestion: {
        ...RINA_SUGGESTION.suggestion,
        flag: { problem: 'outdated', ...lane('harbor-lane') },
      },
      subjects: [
        { type: 'entity', value: s.store.entity() },
        { type: 'memory', value: detail },
      ],
    })
    s.search.result = { ...HARBOR_RECALL, hits: [{ ...HARBOR_RECALL.hits[0]!, memory }] }
    const returned = JSON.stringify([
      await s.curator.waiting({}, signal),
      await s.curator.suggestion({ suggestionId: 'sugg-rina' }, signal),
      await s.curator.entity({ entityId: 'rina' }, signal),
      await s.curator.memory({ memoryId: memory.id }, signal),
      await s.curator.search({ query: 'Harbor' }, signal),
    ])
    expect(returned).not.toContain('harbor-secret-123')
    expect(returned.split('Harbor [redacted]').length - 1).toBe(10)
  })

  it('search ranks no lane project first', async () => {
    const s = await curatorSetup()
    await s.curator.search({ query: 'Harbor', cwd: '/projects/harbor', limit: 3 }, signal)
    expect(s.search.searches[0]).toMatchObject({
      query: 'Harbor',
      scope: null,
      branch: null,
      limit: 3,
    })
    expect(s.search.searches[0]!.vector).toBeInstanceOf(Float32Array)
  })

  it('works with lane recall off, and refuses every read when Brain is off', async () => {
    const s = await curatorSetup()
    s.store.prefs.recall = false
    await expect(s.curator.waiting({}, signal)).resolves.toMatchObject({ items: [] })
    s.store.prefs.enabled = false
    for (const read of [
      () => s.curator.waiting({}, signal),
      () => s.curator.suggestion({ suggestionId: 's' }, signal),
      () => s.curator.entity({ entityId: 'e' }, signal),
      () => s.curator.memory({ memoryId: 'm' }, signal),
      () => s.curator.search({ query: 'Harbor' }, signal),
    ])
      await expect(read()).rejects.toThrow(BRAIN_OFF)
  })
})
