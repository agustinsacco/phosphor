import { describe, expect, it } from 'vitest'
import { mergeAgentPatch } from './agent-settings'

describe('mergeAgentPatch', () => {
  it('replaces top-level keys and keeps unrelated ones', () => {
    expect(
      mergeAgentPatch({ theme: 'dark', packages: ['npm:x'] }, { defaultModel: 'opus' }),
    ).toEqual({ theme: 'dark', packages: ['npm:x'], defaultModel: 'opus' })
  })

  it('merges compaction and retry one level deep, keeping unknown nested fields', () => {
    const current = {
      compaction: { enabled: true, reserveTokens: 50000, futureField: 1 },
      retry: { maxRetries: 3 },
    }
    expect(
      mergeAgentPatch(current, {
        compaction: { keepRecentTokens: 20000 },
        retry: { enabled: false },
      }),
    ).toEqual({
      compaction: { enabled: true, reserveTokens: 50000, futureField: 1, keepRecentTokens: 20000 },
      retry: { maxRetries: 3, enabled: false },
    })
    expect(mergeAgentPatch({}, { retry: { maxRetries: 1 } })).toEqual({ retry: { maxRetries: 1 } })
  })

  it('refuses to replace a nested group that is not an object', () => {
    expect(() => mergeAgentPatch({ compaction: true }, { compaction: { enabled: false } })).toThrow(
      'Invalid compaction settings. Nothing was overwritten.',
    )
  })

  it('merges only the nested keys it is given', () => {
    const current = { agentDirectives: { awareness: true }, compaction: { enabled: true } }
    expect(
      mergeAgentPatch(current, { agentDirectives: { workflow: false } }, ['agentDirectives']),
    ).toEqual({
      agentDirectives: { awareness: true, workflow: false },
      compaction: { enabled: true },
    })
    expect(mergeAgentPatch(current, { compaction: { reserveTokens: 1 } }, [])).toEqual({
      agentDirectives: { awareness: true },
      compaction: { reserveTokens: 1 },
    })
  })

  it('does not modify its inputs', () => {
    const current = { compaction: { enabled: true } }
    const patch = { compaction: { reserveTokens: 1 } }
    mergeAgentPatch(current, patch)
    expect(current).toEqual({ compaction: { enabled: true } })
    expect(patch).toEqual({ compaction: { reserveTokens: 1 } })
  })

  it('deletes keys and nested fields set to null or undefined, dropping an emptied group', () => {
    const current = {
      theme: 'dark',
      defaultModel: 'opus',
      compaction: { enabled: false, reserveTokens: 4096 },
      retry: { maxRetries: 2 },
    }
    expect(
      mergeAgentPatch(current, {
        defaultModel: null,
        theme: undefined,
        compaction: { enabled: null },
        retry: { maxRetries: undefined },
      }),
    ).toEqual({ compaction: { reserveTokens: 4096 } })
    expect(mergeAgentPatch(current, { compaction: null })).not.toHaveProperty('compaction')
  })
})
