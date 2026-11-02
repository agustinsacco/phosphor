import { describe, expect, it } from 'vitest'
import { SUBAGENT_SESSION_ENTRIES as entries } from './__fixtures__/subagent-session-entries'
import { isSubagentNotice, subagentEvidence } from './subagent-evidence'

describe('subagentEvidence', () => {
  it('keeps the active branch subagent records, chained root to leaf', () => {
    const evidence = subagentEvidence(entries, 'done')
    expect(evidence.entries.map((e) => [e.id, e.parentId])).toEqual([
      ['call', null],
      ['sub-result', 'call'],
      ['ask', 'sub-result'],
      ['reply', 'ask'],
    ])
    expect(evidence.leafId).toBe('reply')
  })
  it('cuts assistant messages down to their subagent calls', () => {
    const [call] = subagentEvidence(entries, 'done').entries
    expect(call?.message).toMatchObject({
      role: 'assistant',
      timestamp: 1791806401000,
      content: [{ type: 'toolCall', id: 't-sub', name: 'subagent' }],
    })
    expect((call?.message as { content: unknown[] }).content).toHaveLength(1)
  })
  it('changes nothing when applied twice, so a reader may apply it to a Host reply', () => {
    const once = subagentEvidence(entries, 'done')
    expect(subagentEvidence(once.entries, once.leafId)).toEqual(once)
  })
  it('reads the branch it is given, and nothing for an empty one', () => {
    expect(subagentEvidence(entries, 'elsewhere').entries.map((e) => e.id)).toEqual([
      'call',
      'sub-result',
      'elsewhere',
    ])
    expect(subagentEvidence(entries, 'user')).toEqual({ entries: [], leafId: null })
    expect(subagentEvidence(entries, null)).toEqual({ entries: [], leafId: null })
    expect(subagentEvidence([null, 'x', { id: 1 }, ...entries], 'done').leafId).toBe('reply')
  })
  it('refuses a leaf it cannot find', () => {
    expect(() => subagentEvidence(entries, 'missing')).toThrow(
      'The active history branch is unavailable.',
    )
  })
  it('knows the native notice types', () => {
    expect(isSubagentNotice('subagent-notify')).toBe(true)
    expect(isSubagentNotice('subagent_supervisor_reply')).toBe(true)
    expect(isSubagentNotice('artifact')).toBe(false)
    expect(isSubagentNotice(undefined)).toBe(false)
  })
})
